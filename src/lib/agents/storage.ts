import fs from 'fs/promises';
import path from 'path';
import { Agent, CreateAgentRequest } from './types';
import { randomUUID } from 'crypto';

const DATA_DIR = path.join(process.cwd(), 'data', 'agents');
const AGENTS_FILE = path.join(DATA_DIR, 'config.json');

async function ensureDataDir() {
    try {
        await fs.access(DATA_DIR);
    } catch {
        await fs.mkdir(DATA_DIR, { recursive: true });
    }
}

export async function loadAgents(): Promise<Agent[]> {
    await ensureDataDir();
    try {
        const data = await fs.readFile(AGENTS_FILE, 'utf-8');
        return JSON.parse(data);
    } catch {
        return [];
    }
}

export async function saveAgents(agents: Agent[]): Promise<void> {
    await ensureDataDir();
    await fs.writeFile(AGENTS_FILE, JSON.stringify(agents, null, 2));
}

export async function createAgent(input: CreateAgentRequest): Promise<Agent> {
    const agents = await loadAgents();
    const newAgent: Agent = {
        id: randomUUID(),
        ...input,
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    agents.push(newAgent);
    await saveAgents(agents);
    return newAgent;
}

export async function deleteAgent(id: string): Promise<void> {
    const agents = await loadAgents();
    const filtered = agents.filter(a => a.id !== id);
    await saveAgents(filtered);
}

export async function updateAgent(id: string, updates: Partial<Agent>): Promise<Agent | null> {
    const agents = await loadAgents();
    const index = agents.findIndex(a => a.id === id);
    if (index === -1) return null;

    agents[index] = { ...agents[index], ...updates, updatedAt: new Date().toISOString() };
    await saveAgents(agents);
    return agents[index];
}
