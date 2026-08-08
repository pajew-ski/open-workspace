/**
 * Canvas Storage - Multiple Canvases Support
 */

import { promises as fs } from 'fs';
import path from 'path';
import { readJsonSafe, withFileLock, writeJsonAtomic } from './atomic';

const DATA_DIR = path.join(process.cwd(), 'data', 'canvas');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

export interface CanvasCard {
    id: string;
    type: 'note' | 'task' | 'link' | 'image';
    title: string;
    content?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    color?: string;
    createdAt: string;
    updatedAt: string;
}

export interface CanvasConnection {
    id: string;
    fromId: string;
    toId: string;
    type: 'simple' | 'directional' | 'bidirectional';
    label?: string;
}

export interface CanvasData {
    id: string;
    name: string;
    description?: string;
    cards: CanvasCard[];
    connections: CanvasConnection[];
    viewport: { x: number; y: number; zoom: number };
    createdAt: string;
    updatedAt: string;
}

export interface CanvasIndex {
    canvases: Array<{
        id: string;
        name: string;
        description?: string;
        cardCount: number;
        createdAt: string;
        updatedAt: string;
    }>;
}

function getCanvasPath(id: string): string {
    return path.join(DATA_DIR, `${id}.json`);
}

async function readIndex(): Promise<CanvasIndex> {
    return readJsonSafe<CanvasIndex>(INDEX_FILE, { canvases: [] });
}

async function writeIndex(index: CanvasIndex): Promise<void> {
    await writeJsonAtomic(INDEX_FILE, index);
}

/** Serialized read-modify-write on the index file. */
async function updateIndex(mutate: (index: CanvasIndex) => void): Promise<void> {
    await withFileLock(INDEX_FILE, async () => {
        const index = await readIndex();
        mutate(index);
        await writeIndex(index);
    });
}

function generateId(): string {
    return `canvas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function generateCardId(): string {
    return `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Canvas CRUD
export async function listCanvases(): Promise<CanvasIndex['canvases']> {
    const index = await readIndex();
    return index.canvases.sort((a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
}

export async function getCanvas(id: string): Promise<CanvasData | null> {
    return readJsonSafe<CanvasData | null>(getCanvasPath(id), null);
}

export async function createCanvas(name: string, description?: string): Promise<CanvasData> {
    const now = new Date().toISOString();
    const id = generateId();

    const canvas: CanvasData = {
        id,
        name,
        description,
        cards: [],
        connections: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        createdAt: now,
        updatedAt: now,
    };

    await writeJsonAtomic(getCanvasPath(id), canvas);

    await updateIndex(index => {
        index.canvases.push({
            id,
            name,
            description,
            cardCount: 0,
            createdAt: now,
            updatedAt: now,
        });
    });

    return canvas;
}

export async function updateCanvasMeta(id: string, updates: { name?: string; description?: string }): Promise<CanvasData | null> {
    const canvasPath = getCanvasPath(id);
    const now = new Date().toISOString();

    const updated = await withFileLock(canvasPath, async () => {
        const canvas = await getCanvas(id);
        if (!canvas) return null;

        const next = { ...canvas, ...updates, updatedAt: now };
        await writeJsonAtomic(canvasPath, next);
        return next;
    });

    if (!updated) return null;

    await updateIndex(index => {
        const idx = index.canvases.findIndex(c => c.id === id);
        if (idx !== -1) {
            index.canvases[idx] = { ...index.canvases[idx], ...updates, updatedAt: now };
        }
    });

    return updated;
}

export async function deleteCanvas(id: string): Promise<boolean> {
    const canvasPath = getCanvasPath(id);

    const removed = await withFileLock(canvasPath, async () => {
        try {
            await fs.unlink(canvasPath);
            return true;
        } catch {
            return false;
        }
    });

    if (!removed) return false;

    await updateIndex(index => {
        index.canvases = index.canvases.filter(c => c.id !== id);
    });

    return true;
}

/**
 * Serialized read-modify-write on a single canvas file.
 * Returns null if the canvas does not exist.
 */
async function mutateCanvas<T>(
    canvasId: string,
    mutate: (canvas: CanvasData) => T | null
): Promise<{ canvas: CanvasData; result: T } | null> {
    const canvasPath = getCanvasPath(canvasId);

    return withFileLock(canvasPath, async () => {
        const canvas = await getCanvas(canvasId);
        if (!canvas) return null;

        const result = mutate(canvas);
        if (result === null) return null;

        await writeJsonAtomic(canvasPath, canvas);
        return { canvas, result };
    });
}

async function syncIndexForCanvas(canvas: CanvasData): Promise<void> {
    await updateIndex(index => {
        const idx = index.canvases.findIndex(c => c.id === canvas.id);
        if (idx !== -1) {
            index.canvases[idx].cardCount = canvas.cards.length;
            index.canvases[idx].updatedAt = canvas.updatedAt;
        }
    });
}

// Card operations
export async function createCard(canvasId: string, input: {
    type?: CanvasCard['type'];
    title: string;
    content?: string;
    x: number;
    y: number;
    width?: number;
    height?: number;
    color?: string;
}): Promise<CanvasCard | null> {
    const now = new Date().toISOString();

    const outcome = await mutateCanvas(canvasId, canvas => {
        const card: CanvasCard = {
            id: generateCardId(),
            type: input.type || 'note',
            title: input.title,
            content: input.content,
            x: input.x,
            y: input.y,
            width: input.width || 240,
            height: input.height || 180,
            color: input.color,
            createdAt: now,
            updatedAt: now,
        };

        canvas.cards.push(card);
        canvas.updatedAt = now;
        return card;
    });

    if (!outcome) return null;

    await syncIndexForCanvas(outcome.canvas);
    return outcome.result;
}

export async function updateCard(canvasId: string, cardId: string, updates: Partial<Omit<CanvasCard, 'id' | 'createdAt'>>): Promise<CanvasCard | null> {
    const now = new Date().toISOString();

    const outcome = await mutateCanvas(canvasId, canvas => {
        const cardIndex = canvas.cards.findIndex(c => c.id === cardId);
        if (cardIndex === -1) return null;

        canvas.cards[cardIndex] = { ...canvas.cards[cardIndex], ...updates, updatedAt: now };
        canvas.updatedAt = now;
        return canvas.cards[cardIndex];
    });

    return outcome ? outcome.result : null;
}

export async function deleteCard(canvasId: string, cardId: string): Promise<boolean> {
    const outcome = await mutateCanvas(canvasId, canvas => {
        const cardIndex = canvas.cards.findIndex(c => c.id === cardId);
        if (cardIndex === -1) return null;

        canvas.cards.splice(cardIndex, 1);
        canvas.connections = canvas.connections.filter(c => c.fromId !== cardId && c.toId !== cardId);
        canvas.updatedAt = new Date().toISOString();
        return true;
    });

    if (!outcome) return false;

    await syncIndexForCanvas(outcome.canvas);
    return true;
}

// Connection operations
export async function createConnection(
    canvasId: string,
    fromId: string,
    toId: string,
    type: CanvasConnection['type'] = 'directional',
    label?: string
): Promise<CanvasConnection | null> {
    const outcome = await mutateCanvas(canvasId, canvas => {
        const fromCard = canvas.cards.find(c => c.id === fromId);
        const toCard = canvas.cards.find(c => c.id === toId);
        if (!fromCard || !toCard) return null;

        const connection: CanvasConnection = {
            id: `conn-${Date.now()}`,
            fromId,
            toId,
            type,
            label,
        };

        canvas.connections.push(connection);
        canvas.updatedAt = new Date().toISOString();
        return connection;
    });

    return outcome ? outcome.result : null;
}

export async function updateConnection(canvasId: string, connectionId: string, updates: Partial<Omit<CanvasConnection, 'id'>>): Promise<CanvasConnection | null> {
    const outcome = await mutateCanvas(canvasId, canvas => {
        const connIndex = canvas.connections.findIndex(c => c.id === connectionId);
        if (connIndex === -1) return null;

        canvas.connections[connIndex] = { ...canvas.connections[connIndex], ...updates };
        canvas.updatedAt = new Date().toISOString();
        return canvas.connections[connIndex];
    });

    return outcome ? outcome.result : null;
}

export async function deleteConnection(canvasId: string, connectionId: string): Promise<boolean> {
    const outcome = await mutateCanvas(canvasId, canvas => {
        const connIndex = canvas.connections.findIndex(c => c.id === connectionId);
        if (connIndex === -1) return null;

        canvas.connections.splice(connIndex, 1);
        canvas.updatedAt = new Date().toISOString();
        return true;
    });

    return outcome !== null;
}

export async function updateViewport(canvasId: string, viewport: CanvasData['viewport']): Promise<void> {
    await mutateCanvas(canvasId, canvas => {
        canvas.viewport = viewport;
        return true;
    });
}
