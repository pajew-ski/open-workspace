import path from 'path';
import { Tool, CreateToolRequest } from './types';
import { randomUUID } from 'crypto';
import { readJsonSafe, withFileLock, writeJsonAtomic } from '@/lib/storage/atomic';

const DATA_DIR = path.join(process.cwd(), 'data', 'tools');
const TOOLS_FILE = path.join(DATA_DIR, 'tools.json');

export async function loadTools(): Promise<Tool[]> {
    return readJsonSafe<Tool[]>(TOOLS_FILE, []);
}

export async function saveTools(tools: Tool[]): Promise<void> {
    await writeJsonAtomic(TOOLS_FILE, tools);
}

export async function createTool(input: CreateToolRequest): Promise<Tool> {
    return withFileLock(TOOLS_FILE, async () => {
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
    });
}

export async function deleteTool(id: string): Promise<void> {
    return withFileLock(TOOLS_FILE, async () => {
        const tools = await loadTools();
        const filtered = tools.filter(t => t.id !== id);
        await saveTools(filtered);
    });
}

export async function updateTool(id: string, updates: Partial<Tool>): Promise<Tool | null> {
    return withFileLock(TOOLS_FILE, async () => {
        const tools = await loadTools();
        const index = tools.findIndex(t => t.id === id);
        if (index === -1) return null;

        tools[index] = { ...tools[index], ...updates };
        await saveTools(tools);
        return tools[index];
    });
}
