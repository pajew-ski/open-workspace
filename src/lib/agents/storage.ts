import path from 'path';
import { Agent, CreateAgentRequest } from './types';
import { randomUUID } from 'crypto';
import { readJsonSafe, withFileLock, writeJsonAtomic } from '@/lib/storage/atomic';

const DATA_DIR = path.join(process.cwd(), 'data', 'agents');
const AGENTS_FILE = path.join(DATA_DIR, 'config.json');

export async function loadAgents(): Promise<Agent[]> {
    return readJsonSafe<Agent[]>(AGENTS_FILE, []);
}

export async function saveAgents(agents: Agent[]): Promise<void> {
    await writeJsonAtomic(AGENTS_FILE, agents);
}

export async function createAgent(input: CreateAgentRequest): Promise<Agent> {
    return withFileLock(AGENTS_FILE, async () => {
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
    });
}

export async function deleteAgent(id: string): Promise<void> {
    return withFileLock(AGENTS_FILE, async () => {
        const agents = await loadAgents();
        const filtered = agents.filter(a => a.id !== id);
        await saveAgents(filtered);
    });
}

export async function updateAgent(id: string, updates: Partial<Agent>): Promise<Agent | null> {
    return withFileLock(AGENTS_FILE, async () => {
        const agents = await loadAgents();
        const index = agents.findIndex(a => a.id === id);
        if (index === -1) return null;

        agents[index] = { ...agents[index], ...updates, updatedAt: new Date().toISOString() };
        await saveAgents(agents);
        return agents[index];
    });
}
