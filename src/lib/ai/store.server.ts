import path from 'path';
import { randomUUID } from 'crypto';
import { readJsonSafe, withFileLock, writeJsonAtomic } from '@/lib/storage/atomic';
import { encrypt, decrypt } from '@/lib/security/encryption';
import { loadSettings } from '@/lib/settings';
import type { AIConfig, AIProvider, McpServerConfig, ResolvedProvider } from './types';
import { resolveProtocol } from './client';

/**
 * Server-side persistence of the AI platform config (data/ai/config.json).
 *
 * Secrets (provider API keys, MCP auth header values) are stored encrypted
 * (AES-256-GCM via the existing encryption module) or as "ENV:VAR"
 * references. They are decrypted only for execution and NEVER serialized
 * to the client — the client only sees hasServerKey/hasServerAuth flags.
 */

const CONFIG_FILE = path.join(process.cwd(), 'data', 'ai', 'config.json');

/** Placeholder clients send to mean "keep the stored secret". */
export const MASKED_SECRET = '***';

function emptyConfig(): AIConfig {
    return { version: 1, defaults: {}, providers: [], mcpServers: [] };
}

/**
 * One-time migration: builds the initial multi-provider config from the
 * legacy single-endpoint settings (data/settings.json / LLM_* env vars),
 * so existing installations keep working without any reconfiguration.
 */
async function migrateFromLegacy(): Promise<AIConfig> {
    const config = emptyConfig();
    try {
        const legacy = await loadSettings();
        const endpoint = legacy.inference.endpoint?.trim();
        if (endpoint) {
            const isOpenAIStyle = endpoint.includes('/v1');
            const now = new Date().toISOString();
            const provider: AIProvider = {
                id: randomUUID(),
                label: isOpenAIStyle ? 'Migrierter Endpunkt' : 'Ollama (migriert)',
                kind: isOpenAIStyle ? 'custom' : 'ollama',
                baseUrl: endpoint,
                connectionMode: 'auto',
                keyLocation: process.env.LLM_API_KEY || process.env.NEXT_PUBLIC_LLM_API_KEY ? 'server' : 'none',
                apiKeyEnc: process.env.LLM_API_KEY
                    ? 'ENV:LLM_API_KEY'
                    : process.env.NEXT_PUBLIC_LLM_API_KEY
                        ? 'ENV:NEXT_PUBLIC_LLM_API_KEY'
                        : undefined,
                defaultModel: legacy.inference.model || undefined,
                toolCalls: 'auto',
                enabled: true,
                createdAt: now,
                updatedAt: now,
            };
            config.providers.push(provider);
            config.defaults = { providerId: provider.id, model: provider.defaultModel };
        }
    } catch {
        // Legacy settings unavailable → start empty
    }
    return config;
}

export async function loadAIConfig(): Promise<AIConfig> {
    const stored = await readJsonSafe<AIConfig | null>(CONFIG_FILE, null);
    if (stored && Array.isArray(stored.providers)) {
        return {
            version: 1,
            defaults: stored.defaults ?? {},
            providers: stored.providers,
            mcpServers: Array.isArray(stored.mcpServers) ? stored.mcpServers : [],
        };
    }
    const migrated = await migrateFromLegacy();
    await writeJsonAtomic(CONFIG_FILE, migrated);
    return migrated;
}

export async function saveAIConfig(config: AIConfig): Promise<void> {
    await writeJsonAtomic(CONFIG_FILE, config);
}

// ------------------------------------------------------------------
// Secret handling
// ------------------------------------------------------------------

function storeSecret(value: string | undefined, previous: string | undefined): string | undefined {
    if (value === undefined || value === '') return undefined;
    if (value === MASKED_SECRET) return previous;
    if (value.startsWith('ENV:')) return value;
    return encrypt(value);
}

function resolveSecret(stored: string | undefined, label: string): string | undefined {
    if (!stored) return undefined;
    if (stored.startsWith('ENV:')) {
        return process.env[stored.substring(4)] || undefined;
    }
    try {
        return decrypt(stored);
    } catch (error) {
        console.error(`[ai] Failed to decrypt secret for ${label}:`, error instanceof Error ? error.message : error);
        return undefined;
    }
}

// ------------------------------------------------------------------
// Client-safe serialization
// ------------------------------------------------------------------

export type ClientProvider = Omit<AIProvider, 'apiKeyEnc'>;
export type ClientMcpServer = Omit<McpServerConfig, 'authHeaderValueEnc'>;

export function toClientProvider(provider: AIProvider): ClientProvider {
    const { apiKeyEnc, ...rest } = provider;
    return { ...rest, hasServerKey: Boolean(apiKeyEnc) };
}

export function toClientMcpServer(server: McpServerConfig): ClientMcpServer {
    const { authHeaderValueEnc, ...rest } = server;
    return { ...rest, hasServerAuth: Boolean(authHeaderValueEnc) };
}

// ------------------------------------------------------------------
// Provider CRUD
// ------------------------------------------------------------------

export interface ProviderInput {
    label: string;
    kind: AIProvider['kind'];
    baseUrl: string;
    connectionMode: AIProvider['connectionMode'];
    keyLocation: AIProvider['keyLocation'];
    /** Plaintext key, "ENV:VAR", or MASKED_SECRET to keep the stored one. */
    apiKey?: string;
    defaultModel?: string;
    pinnedModels?: string[];
    toolCalls: AIProvider['toolCalls'];
    enabled: boolean;
}

export async function createProvider(input: ProviderInput): Promise<ClientProvider> {
    return withFileLock(CONFIG_FILE, async () => {
        const config = await loadAIConfig();
        const now = new Date().toISOString();
        const provider: AIProvider = {
            id: randomUUID(),
            label: input.label,
            kind: input.kind,
            baseUrl: input.baseUrl,
            connectionMode: input.connectionMode,
            keyLocation: input.keyLocation,
            apiKeyEnc: input.keyLocation === 'server' ? storeSecret(input.apiKey, undefined) : undefined,
            defaultModel: input.defaultModel,
            pinnedModels: input.pinnedModels,
            toolCalls: input.toolCalls,
            enabled: input.enabled,
            createdAt: now,
            updatedAt: now,
        };
        config.providers.push(provider);
        // First configured provider becomes the default automatically.
        if (!config.defaults.providerId) {
            config.defaults = { providerId: provider.id, model: provider.defaultModel };
        }
        await saveAIConfig(config);
        return toClientProvider(provider);
    });
}

export async function updateProvider(id: string, input: Partial<ProviderInput>): Promise<ClientProvider | null> {
    return withFileLock(CONFIG_FILE, async () => {
        const config = await loadAIConfig();
        const index = config.providers.findIndex(p => p.id === id);
        if (index === -1) return null;
        const existing = config.providers[index];

        const keyLocation = input.keyLocation ?? existing.keyLocation;
        let apiKeyEnc = existing.apiKeyEnc;
        if (keyLocation !== 'server') {
            apiKeyEnc = undefined;
        } else if (input.apiKey !== undefined) {
            apiKeyEnc = storeSecret(input.apiKey, existing.apiKeyEnc);
        }

        const updated: AIProvider = {
            ...existing,
            label: input.label ?? existing.label,
            kind: input.kind ?? existing.kind,
            baseUrl: input.baseUrl ?? existing.baseUrl,
            connectionMode: input.connectionMode ?? existing.connectionMode,
            keyLocation,
            apiKeyEnc,
            defaultModel: input.defaultModel !== undefined ? input.defaultModel : existing.defaultModel,
            pinnedModels: input.pinnedModels !== undefined ? input.pinnedModels : existing.pinnedModels,
            toolCalls: input.toolCalls ?? existing.toolCalls,
            enabled: input.enabled ?? existing.enabled,
            updatedAt: new Date().toISOString(),
        };
        config.providers[index] = updated;
        if (config.defaults.providerId === id && input.defaultModel !== undefined && !config.defaults.model) {
            config.defaults.model = input.defaultModel;
        }
        await saveAIConfig(config);
        return toClientProvider(updated);
    });
}

export async function deleteProvider(id: string): Promise<void> {
    return withFileLock(CONFIG_FILE, async () => {
        const config = await loadAIConfig();
        config.providers = config.providers.filter(p => p.id !== id);
        if (config.defaults.providerId === id) {
            const next = config.providers.find(p => p.enabled);
            config.defaults = next ? { providerId: next.id, model: next.defaultModel } : {};
        }
        await saveAIConfig(config);
    });
}

export async function setDefaults(providerId: string | undefined, model: string | undefined): Promise<void> {
    return withFileLock(CONFIG_FILE, async () => {
        const config = await loadAIConfig();
        config.defaults = { providerId, model };
        await saveAIConfig(config);
    });
}

/** Resolve a provider for SERVER-side execution (decrypted key, context 'server'). */
export async function resolveServerProvider(id: string): Promise<ResolvedProvider | null> {
    const config = await loadAIConfig();
    const provider = config.providers.find(p => p.id === id);
    if (!provider) return null;
    return {
        provider,
        protocol: resolveProtocol(provider),
        apiKey: resolveSecret(provider.apiKeyEnc, `provider ${provider.label}`),
        context: 'server',
    };
}

/** The server-side default provider (used when a request names none). */
export async function resolveDefaultServerProvider(): Promise<{ resolved: ResolvedProvider; model?: string } | null> {
    const config = await loadAIConfig();
    const id = config.defaults.providerId ?? config.providers.find(p => p.enabled)?.id;
    if (!id) return null;
    const resolved = await resolveServerProvider(id);
    if (!resolved) return null;
    return { resolved, model: config.defaults.model };
}

// ------------------------------------------------------------------
// MCP server CRUD
// ------------------------------------------------------------------

export interface McpServerInput {
    label: string;
    url: string;
    transport: McpServerConfig['transport'];
    connectionMode: McpServerConfig['connectionMode'];
    authHeaderName?: string;
    /** Plaintext value, "ENV:VAR", or MASKED_SECRET to keep the stored one. */
    authHeaderValue?: string;
    enabled: boolean;
}

export async function createMcpServer(input: McpServerInput): Promise<ClientMcpServer> {
    return withFileLock(CONFIG_FILE, async () => {
        const config = await loadAIConfig();
        const now = new Date().toISOString();
        const server: McpServerConfig = {
            id: randomUUID(),
            label: input.label,
            url: input.url,
            transport: input.transport,
            connectionMode: input.connectionMode,
            authHeaderName: input.authHeaderName,
            authHeaderValueEnc: storeSecret(input.authHeaderValue, undefined),
            enabled: input.enabled,
            createdAt: now,
            updatedAt: now,
        };
        config.mcpServers.push(server);
        await saveAIConfig(config);
        return toClientMcpServer(server);
    });
}

export async function updateMcpServer(id: string, input: Partial<McpServerInput>): Promise<ClientMcpServer | null> {
    return withFileLock(CONFIG_FILE, async () => {
        const config = await loadAIConfig();
        const index = config.mcpServers.findIndex(s => s.id === id);
        if (index === -1) return null;
        const existing = config.mcpServers[index];
        const updated: McpServerConfig = {
            ...existing,
            label: input.label ?? existing.label,
            url: input.url ?? existing.url,
            transport: input.transport ?? existing.transport,
            connectionMode: input.connectionMode ?? existing.connectionMode,
            authHeaderName: input.authHeaderName !== undefined ? input.authHeaderName : existing.authHeaderName,
            authHeaderValueEnc: input.authHeaderValue !== undefined
                ? storeSecret(input.authHeaderValue, existing.authHeaderValueEnc)
                : existing.authHeaderValueEnc,
            enabled: input.enabled ?? existing.enabled,
            updatedAt: new Date().toISOString(),
        };
        config.mcpServers[index] = updated;
        await saveAIConfig(config);
        return toClientMcpServer(updated);
    });
}

export async function deleteMcpServer(id: string): Promise<void> {
    return withFileLock(CONFIG_FILE, async () => {
        const config = await loadAIConfig();
        config.mcpServers = config.mcpServers.filter(s => s.id !== id);
        await saveAIConfig(config);
    });
}

/** MCP server with decrypted auth header for SERVER-side connections. */
export async function resolveMcpServerAuth(id: string): Promise<{ server: McpServerConfig; headers: Record<string, string> } | null> {
    const config = await loadAIConfig();
    const server = config.mcpServers.find(s => s.id === id);
    if (!server) return null;
    const headers: Record<string, string> = {};
    if (server.authHeaderName) {
        const value = resolveSecret(server.authHeaderValueEnc, `mcp ${server.label}`);
        if (value) headers[server.authHeaderName] = value;
    }
    return { server, headers };
}
