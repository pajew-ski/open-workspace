import fs from 'fs/promises';
import path from 'path';
import { Tool, CreateToolRequest } from './types';
import { randomUUID } from 'crypto';

const DATA_DIR = path.join(process.cwd(), 'data', 'tools');
const TOOLS_FILE = path.join(DATA_DIR, 'tools.json');

async function ensureDataDir() {
    try {
        await fs.access(DATA_DIR);
    } catch {
        await fs.mkdir(DATA_DIR, { recursive: true });
    }
}

export async function loadTools(): Promise<Tool[]> {
    await ensureDataDir();
    try {
        const data = await fs.readFile(TOOLS_FILE, 'utf-8');
        return JSON.parse(data);
    } catch {
        return [];
    }
}

export async function saveTools(tools: Tool[]): Promise<void> {
    await ensureDataDir();
    await fs.writeFile(TOOLS_FILE, JSON.stringify(tools, null, 2));
}

export async function createTool(input: CreateToolRequest): Promise<Tool> {
    const tools = await loadTools();
    const newTool: Tool = {
        id: randomUUID(),
        ...input,
        enabled: true,
        createdAt: new Date().toISOString(),
    };
    tools.push(newTool);
    await saveTools(tools);
    return newTool;
}

export async function deleteTool(id: string): Promise<void> {
    const tools = await loadTools();
    const filtered = tools.filter(t => t.id !== id);
    await saveTools(filtered);
}

export async function updateTool(id: string, updates: Partial<Tool>): Promise<Tool | null> {
    const tools = await loadTools();
    const index = tools.findIndex(t => t.id === id);
    if (index === -1) return null;

    tools[index] = { ...tools[index], ...updates };
    await saveTools(tools);
    return tools[index];
}
