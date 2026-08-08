import path from 'path';
import { AuthConfig, Connection, CreateConnectionRequest } from './types';
import { encrypt, decrypt } from '@/lib/security/encryption';
import { randomUUID } from 'crypto';
import { readJsonSafe, withFileLock, writeJsonAtomic } from '@/lib/storage/atomic';

const DATA_DIR = path.join(process.cwd(), 'data', 'connections');
const CONNECTIONS_FILE = path.join(DATA_DIR, 'config.json');

/** Placeholder the API layer uses when masking secrets in list responses. */
export const MASKED_SECRET = '***';

const SECRET_FIELDS = ['token', 'password', 'apiKey'] as const;

export async function loadConnections(): Promise<Connection[]> {
    return readJsonSafe<Connection[]>(CONNECTIONS_FILE, []);
}

export async function saveConnections(connections: Connection[]): Promise<void> {
    await writeJsonAtomic(CONNECTIONS_FILE, connections);
}

/**
 * Encrypt secret fields of an auth config for storage.
 * - "ENV:*" references are stored verbatim.
 * - The mask placeholder ("***") keeps the previously stored value, so a
 *   client round-tripping a masked connection cannot destroy real secrets.
 */
function prepareAuthForStorage(input: AuthConfig, previous?: AuthConfig): AuthConfig {
    const auth: AuthConfig = { ...input };

    for (const field of SECRET_FIELDS) {
        const value = auth[field];
        if (value === undefined) continue;

        if (value === MASKED_SECRET && previous?.[field]) {
            auth[field] = previous[field];
            continue;
        }

        if (value && !value.startsWith('ENV:')) {
            auth[field] = encrypt(value);
        }
    }

    return auth;
}

/**
 * Creates a new connection. Encrypts sensitive fields before saving.
 */
export async function createConnection(input: CreateConnectionRequest): Promise<Connection> {
    return withFileLock(CONNECTIONS_FILE, async () => {
        const connections = await loadConnections();

        const newConnection: Connection = {
            id: randomUUID(),
            ...input,
            auth: prepareAuthForStorage(input.auth),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        connections.push(newConnection);
        await saveConnections(connections);
        return newConnection;
    });
}

/**
 * Updates name/description/baseUrl/auth of a connection.
 * When auth is provided, its secrets are (re-)encrypted; masked values ("***")
 * keep the previously stored secret.
 */
export async function updateConnection(
    id: string,
    updates: {
        name?: string;
        description?: string;
        baseUrl?: string;
        auth?: AuthConfig;
    }
): Promise<Connection | null> {
    return withFileLock(CONNECTIONS_FILE, async () => {
        const connections = await loadConnections();
        const index = connections.findIndex(c => c.id === id);
        if (index === -1) return null;

        const existing = connections[index];
        const updated: Connection = {
            ...existing,
            ...(updates.name !== undefined ? { name: updates.name } : {}),
            ...(updates.description !== undefined ? { description: updates.description } : {}),
            ...(updates.baseUrl !== undefined ? { baseUrl: updates.baseUrl } : {}),
            auth: updates.auth ? prepareAuthForStorage(updates.auth, existing.auth) : existing.auth,
            updatedAt: new Date().toISOString(),
        };

        connections[index] = updated;
        await saveConnections(connections);
        return updated;
    });
}

/**
 * Gets a connection with DECRYPTED secrets ready for use.
 * Resolves ENV: variables.
 *
 * SECURITY: if a stored secret cannot be decrypted (wrong/rotated master key,
 * tampered or legacy plaintext value), the field is returned as undefined and
 * the error is logged. The raw ciphertext is NEVER returned, so it can never
 * leak into request headers.
 */
export async function getConnectionWithSecrets(id: string): Promise<Connection | null> {
    const connections = await loadConnections();
    const conn = connections.find(c => c.id === id);
    if (!conn) return null;

    const resolveSecret = (field: string, val?: string): string | undefined => {
        if (!val) return undefined;
        if (val.startsWith('ENV:')) {
            const envVar = val.substring(4);
            return process.env[envVar] || '';
        }
        try {
            return decrypt(val);
        } catch (error) {
            console.error(
                `[connections] Failed to decrypt "${field}" of connection ${conn.id} (${conn.name}). ` +
                'The secret will be treated as unavailable:',
                error instanceof Error ? error.message : error
            );
            return undefined;
        }
    };

    const decryptedAuth: AuthConfig = { ...conn.auth };
    decryptedAuth.token = resolveSecret('token', conn.auth.token);
    decryptedAuth.password = resolveSecret('password', conn.auth.password);
    decryptedAuth.apiKey = resolveSecret('apiKey', conn.auth.apiKey);

    return { ...conn, auth: decryptedAuth };
}

export async function deleteConnection(id: string): Promise<void> {
    return withFileLock(CONNECTIONS_FILE, async () => {
        const connections = await loadConnections();
        const filtered = connections.filter(c => c.id !== id);
        await saveConnections(filtered);
    });
}
