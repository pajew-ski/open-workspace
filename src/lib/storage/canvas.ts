/**
 * Canvas Storage - Multiple Canvases Support
 */

import { promises as fs } from 'fs';
import path from 'path';

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

async function ensureDataDir(): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true });
}

async function getCanvasPath(id: string): Promise<string> {
    return path.join(DATA_DIR, `${id}.json`);
}

async function readIndex(): Promise<CanvasIndex> {
    await ensureDataDir();
    try {
        const content = await fs.readFile(INDEX_FILE, 'utf-8');
        return JSON.parse(content);
    } catch {
        return { canvases: [] };
    }
}

async function writeIndex(index: CanvasIndex): Promise<void> {
    await fs.writeFile(INDEX_FILE, JSON.stringify(index, null, 2));
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
    try {
        const filePath = await getCanvasPath(id);
        const content = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(content);
    } catch {
        return null;
    }
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

    await ensureDataDir();
    const filePath = await getCanvasPath(id);
    await fs.writeFile(filePath, JSON.stringify(canvas, null, 2));

    const index = await readIndex();
    index.canvases.push({
        id,
        name,
        description,
        cardCount: 0,
        createdAt: now,
        updatedAt: now,
    });
    await writeIndex(index);

    return canvas;
}

export async function updateCanvasMeta(id: string, updates: { name?: string; description?: string }): Promise<CanvasData | null> {
    const canvas = await getCanvas(id);
    if (!canvas) return null;

    const now = new Date().toISOString();
    const updated = { ...canvas, ...updates, updatedAt: now };

    const filePath = await getCanvasPath(id);
    await fs.writeFile(filePath, JSON.stringify(updated, null, 2));

    const index = await readIndex();
    const idx = index.canvases.findIndex(c => c.id === id);
    if (idx !== -1) {
        index.canvases[idx] = { ...index.canvases[idx], ...updates, updatedAt: now };
        await writeIndex(index);
    }

    return updated;
}

export async function deleteCanvas(id: string): Promise<boolean> {
    try {
        const filePath = await getCanvasPath(id);
        await fs.unlink(filePath);

        const index = await readIndex();
        index.canvases = index.canvases.filter(c => c.id !== id);
        await writeIndex(index);

        return true;
    } catch {
        return false;
    }
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
    const canvas = await getCanvas(canvasId);
    if (!canvas) return null;

    const now = new Date().toISOString();
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

    const filePath = await getCanvasPath(canvasId);
    await fs.writeFile(filePath, JSON.stringify(canvas, null, 2));

    // Update index
    const index = await readIndex();
    const idx = index.canvases.findIndex(c => c.id === canvasId);
    if (idx !== -1) {
        index.canvases[idx].cardCount = canvas.cards.length;
        index.canvases[idx].updatedAt = now;
        await writeIndex(index);
    }

    return card;
}

export async function updateCard(canvasId: string, cardId: string, updates: Partial<Omit<CanvasCard, 'id' | 'createdAt'>>): Promise<CanvasCard | null> {
    const canvas = await getCanvas(canvasId);
    if (!canvas) return null;

    const cardIndex = canvas.cards.findIndex(c => c.id === cardId);
    if (cardIndex === -1) return null;

    const now = new Date().toISOString();
    canvas.cards[cardIndex] = { ...canvas.cards[cardIndex], ...updates, updatedAt: now };
    canvas.updatedAt = now;

    const filePath = await getCanvasPath(canvasId);
    await fs.writeFile(filePath, JSON.stringify(canvas, null, 2));

    return canvas.cards[cardIndex];
}

export async function deleteCard(canvasId: string, cardId: string): Promise<boolean> {
    const canvas = await getCanvas(canvasId);
    if (!canvas) return false;

    const cardIndex = canvas.cards.findIndex(c => c.id === cardId);
    if (cardIndex === -1) return false;

    canvas.cards.splice(cardIndex, 1);
    canvas.connections = canvas.connections.filter(c => c.fromId !== cardId && c.toId !== cardId);
    canvas.updatedAt = new Date().toISOString();

    const filePath = await getCanvasPath(canvasId);
    await fs.writeFile(filePath, JSON.stringify(canvas, null, 2));

    // Update index
    const index = await readIndex();
    const idx = index.canvases.findIndex(c => c.id === canvasId);
    if (idx !== -1) {
        index.canvases[idx].cardCount = canvas.cards.length;
        index.canvases[idx].updatedAt = canvas.updatedAt;
        await writeIndex(index);
    }

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
    const canvas = await getCanvas(canvasId);
    if (!canvas) return null;

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

    const filePath = await getCanvasPath(canvasId);
    await fs.writeFile(filePath, JSON.stringify(canvas, null, 2));

    return connection;
}

export async function updateConnection(canvasId: string, connectionId: string, updates: Partial<Omit<CanvasConnection, 'id'>>): Promise<CanvasConnection | null> {
    const canvas = await getCanvas(canvasId);
    if (!canvas) return null;

    const connIndex = canvas.connections.findIndex(c => c.id === connectionId);
    if (connIndex === -1) return null;

    canvas.connections[connIndex] = { ...canvas.connections[connIndex], ...updates };
    canvas.updatedAt = new Date().toISOString();

    const filePath = await getCanvasPath(canvasId);
    await fs.writeFile(filePath, JSON.stringify(canvas, null, 2));

    return canvas.connections[connIndex];
}

export async function deleteConnection(canvasId: string, connectionId: string): Promise<boolean> {
    const canvas = await getCanvas(canvasId);
    if (!canvas) return false;

    const connIndex = canvas.connections.findIndex(c => c.id === connectionId);
    if (connIndex === -1) return false;

    canvas.connections.splice(connIndex, 1);
    canvas.updatedAt = new Date().toISOString();

    const filePath = await getCanvasPath(canvasId);
    await fs.writeFile(filePath, JSON.stringify(canvas, null, 2));

    return true;
}

export async function updateViewport(canvasId: string, viewport: CanvasData['viewport']): Promise<void> {
    const canvas = await getCanvas(canvasId);
    if (!canvas) return;

    canvas.viewport = viewport;

    const filePath = await getCanvasPath(canvasId);
    await fs.writeFile(filePath, JSON.stringify(canvas, null, 2));
}
