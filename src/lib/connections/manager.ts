import fs from 'fs/promises';
import path from 'path';
import { Connection, CreateConnectionRequest } from './types';
import { encrypt, decrypt } from '@/lib/security/encryption';
import { randomUUID } from 'crypto';

const DATA_DIR = path.join(process.cwd(), 'data', 'connections');
const CONNECTIONS_FILE = path.join(DATA_DIR, 'config.json');

async function ensureDataDir() {
    try {
        await fs.access(DATA_DIR);
    } catch {
        await fs.mkdir(DATA_DIR, { recursive: true });
    }
}

export async function loadConnections(): Promise<Connection[]> {
    await ensureDataDir();
    try {
        const data = await fs.readFile(CONNECTIONS_FILE, 'utf-8');
        return JSON.parse(data);
    } catch {
        return [];
    }
}

export async function saveConnections(connections: Connection[]): Promise<void> {
    await ensureDataDir();
    await fs.writeFile(CONNECTIONS_FILE, JSON.stringify(connections, null, 2));
}

/**
 * Creates a new connection. Encrypts sensitive fields before saving.
 */
export async function createConnection(input: CreateConnectionRequest): Promise<Connection> {
    const connections = await loadConnections();

    // Encrypt sensitive fields
    const auth = { ...input.auth };
    if (auth.token && !auth.token.startsWith('ENV:')) auth.token = encrypt(auth.token);
    if (auth.password && !auth.password.startsWith('ENV:')) auth.password = encrypt(auth.password);
    if (auth.apiKey && !auth.apiKey.startsWith('ENV:')) auth.apiKey = encrypt(auth.apiKey);

    const newConnection: Connection = {
        id: randomUUID(),
        ...input,
        auth,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };

    connections.push(newConnection);
    await saveConnections(connections);
    return newConnection;
}

/**
 * Gets a connection with DECIPTED secrets ready for use.
 * Resolves ENV: variables.
 */
export async function getConnectionWithSecrets(id: string): Promise<Connection | null> {
    const connections = await loadConnections();
    const conn = connections.find(c => c.id === id);
    if (!conn) return null;

    const resolveSecret = (val?: string) => {
        if (!val) return undefined;
        if (val.startsWith('ENV:')) {
            const envVar = val.substring(4);
            return process.env[envVar] || '';
        }
        try {
            return decrypt(val);
        } catch {
            return val; // Fallback or error?
        }
    };

    const decryptedAuth = { ...conn.auth };
    if (decryptedAuth.token) decryptedAuth.token = resolveSecret(decryptedAuth.token);
    if (decryptedAuth.password) decryptedAuth.password = resolveSecret(decryptedAuth.password);
    if (decryptedAuth.apiKey) decryptedAuth.apiKey = resolveSecret(decryptedAuth.apiKey);

    return { ...conn, auth: decryptedAuth };
}

export async function deleteConnection(id: string): Promise<void> {
    const connections = await loadConnections();
    const filtered = connections.filter(c => c.id !== id);
    await saveConnections(filtered);
}
