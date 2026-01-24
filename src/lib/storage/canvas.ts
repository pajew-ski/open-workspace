/**
 * Canvas Storage - JSON files for visual planning
 */

import { promises as fs } from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data', 'canvas');
const CANVAS_FILE = path.join(DATA_DIR, 'canvas.json');

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
    cards: CanvasCard[];
    connections: CanvasConnection[];
    viewport: {
        x: number;
        y: number;
        zoom: number;
    };
    version: number;
}

async function ensureDataFile(): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true });
    try {
        await fs.access(CANVAS_FILE);
    } catch {
        const initialData: CanvasData = {
            cards: [],
            connections: [],
            viewport: { x: 0, y: 0, zoom: 1 },
            version: 1,
        };
        await fs.writeFile(CANVAS_FILE, JSON.stringify(initialData, null, 2));
    }
}

async function readCanvasData(): Promise<CanvasData> {
    await ensureDataFile();
    const content = await fs.readFile(CANVAS_FILE, 'utf-8');
    return JSON.parse(content);
}

async function writeCanvasData(data: CanvasData): Promise<void> {
    await fs.writeFile(CANVAS_FILE, JSON.stringify(data, null, 2));
}

function generateId(): string {
    return `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function getCanvas(): Promise<CanvasData> {
    return readCanvasData();
}

export async function createCard(input: {
    type?: CanvasCard['type'];
    title: string;
    content?: string;
    x: number;
    y: number;
    width?: number;
    height?: number;
    color?: string;
}): Promise<CanvasCard> {
    const data = await readCanvasData();
    const now = new Date().toISOString();

    const card: CanvasCard = {
        id: generateId(),
        type: input.type || 'note',
        title: input.title,
        content: input.content,
        x: input.x,
        y: input.y,
        width: input.width || 200,
        height: input.height || 150,
        color: input.color,
        createdAt: now,
        updatedAt: now,
    };

    data.cards.push(card);
    await writeCanvasData(data);
    return card;
}

export async function updateCard(id: string, input: Partial<Omit<CanvasCard, 'id' | 'createdAt'>>): Promise<CanvasCard | null> {
    const data = await readCanvasData();
    const index = data.cards.findIndex(c => c.id === id);
    if (index === -1) return null;

    data.cards[index] = {
        ...data.cards[index],
        ...input,
        updatedAt: new Date().toISOString(),
    };

    await writeCanvasData(data);
    return data.cards[index];
}

export async function deleteCard(id: string): Promise<boolean> {
    const data = await readCanvasData();
    const index = data.cards.findIndex(c => c.id === id);
    if (index === -1) return false;

    data.cards.splice(index, 1);
    // Also remove connections involving this card
    data.connections = data.connections.filter(
        c => c.fromId !== id && c.toId !== id
    );

    await writeCanvasData(data);
    return true;
}

export async function createConnection(fromId: string, toId: string, type: CanvasConnection['type'] = 'directional', label?: string): Promise<CanvasConnection | null> {
    const data = await readCanvasData();

    // Verify both cards exist
    const fromCard = data.cards.find(c => c.id === fromId);
    const toCard = data.cards.find(c => c.id === toId);
    if (!fromCard || !toCard) return null;

    const connection: CanvasConnection = {
        id: `conn-${Date.now()}`,
        fromId,
        toId,
        type,
        label,
    };

    data.connections.push(connection);
    await writeCanvasData(data);
    return connection;
}

export async function updateConnection(id: string, updates: Partial<Omit<CanvasConnection, 'id'>>): Promise<CanvasConnection | null> {
    const data = await readCanvasData();
    const index = data.connections.findIndex(c => c.id === id);
    if (index === -1) return null;

    data.connections[index] = { ...data.connections[index], ...updates };
    await writeCanvasData(data);
    return data.connections[index];
}

export async function deleteConnection(id: string): Promise<boolean> {
    const data = await readCanvasData();
    const index = data.connections.findIndex(c => c.id === id);
    if (index === -1) return false;

    data.connections.splice(index, 1);
    await writeCanvasData(data);
    return true;
}

export async function updateViewport(viewport: CanvasData['viewport']): Promise<void> {
    const data = await readCanvasData();
    data.viewport = viewport;
    await writeCanvasData(data);
}
