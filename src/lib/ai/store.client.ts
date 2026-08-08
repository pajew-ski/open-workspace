'use client';

import type { AIDefaults, AIProvider, McpServerConfig, ProbeResult, ResolvedProvider, RouteDecision } from './types';
import { probeProvider, resolveProtocol } from './client';
import { checkBackend } from '@/lib/platform/backend';
import { getBrowserProviderKey } from './keys.client';
import { getPreset } from './presets';
import { isPrivateUrl } from '@/lib/net/private';

/**
 * Client-side gateway to the AI platform config.
 *
 * With a reachable backend, the server config (data/ai/config.json) is
 * the source of truth and is mirrored locally. Without one — static
 * hosting, backend down, offline PWA — the mirror plus browser-local
 * records take over. Records created while serverless live only in this
 * browser and are labeled as such (`origin: 'local'`).
 */

export type ClientProviderRecord = Omit<AIProvider, 'apiKeyEnc'> & { origin: 'server' | 'local' };
export type ClientMcpRecord = Omit<McpServerConfig, 'authHeaderValueEnc'> & { origin: 'server' | 'local' };

export interface ClientAIState {
    backend: 'available' | 'unavailable';
    defaults: AIDefaults;
    providers: ClientProviderRecord[];
    mcpServers: ClientMcpRecord[];
}

const MIRROR_KEY = 'ow.ai.server-mirror';
const LOCAL_CONFIG_KEY = 'ow.ai.local-config';

interface LocalConfig {
    defaults: AIDefaults;
    providers: Array<Omit<AIProvider, 'apiKeyEnc'>>;
    mcpServers: Array<Omit<McpServerConfig, 'authHeaderValueEnc'>>;
}

interface ServerMirror {
    defaults: AIDefaults;
    providers: Array<Omit<AIProvider, 'apiKeyEnc'>>;
    mcpServers: Array<Omit<McpServerConfig, 'authHeaderValueEnc'>>;
}

function readJson<T>(key: string, fallback: T): T {
    if (typeof window === 'undefined') return fallback;
    try {
        const raw = window.localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
        return fallback;
    }
}

function writeJson(key: string, value: unknown): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // best effort
    }
}

function emptyLocalConfig(): LocalConfig {
    return { defaults: {}, providers: [], mcpServers: [] };
}

function readLocalConfig(): LocalConfig {
    const raw = readJson<Partial<LocalConfig>>(LOCAL_CONFIG_KEY, emptyLocalConfig());
    return {
        defaults: raw.defaults ?? {},
        providers: Array.isArray(raw.providers) ? raw.providers : [],
        mcpServers: Array.isArray(raw.mcpServers) ? raw.mcpServers : [],
    };
}

function writeLocalConfig(config: LocalConfig): void {
    writeJson(LOCAL_CONFIG_KEY, config);
}

let localId = 0;
function newLocalId(): string {
    localId += 1;
    return `local-${Date.now().toString(36)}-${localId}-${Math.random().toString(36).slice(2, 8)}`;
}

// ------------------------------------------------------------------
// Loading the merged state
// ------------------------------------------------------------------

export async function loadClientAIState(): Promise<ClientAIState> {
    const backend = await checkBackend();
    const local = readLocalConfig();

    if (backend === 'available') {
        try {
            const response = await fetch('/api/ai/config', { cache: 'no-store' });
            if (response.ok) {
                const data = await response.json() as ServerMirror;
                writeJson(MIRROR_KEY, data);
                return {
                    backend: 'available',
                    defaults: data.defaults ?? {},
                    providers: [
                        ...(data.providers ?? []).map(p => ({ ...p, origin: 'server' as const })),
                        ...local.providers.map(p => ({ ...p, origin: 'local' as const })),
                    ],
                    mcpServers: [
                        ...(data.mcpServers ?? []).map(s => ({ ...s, origin: 'server' as const })),
                        ...local.mcpServers.map(s => ({ ...s, origin: 'local' as const })),
                    ],
                };
            }
        } catch {
            // fall through to mirror
        }
    }

    // Serverless: mirror of the last known server config + local records.
    const mirror = readJson<ServerMirror>(MIRROR_KEY, { defaults: {}, providers: [], mcpServers: [] });
    const defaults: AIDefaults = local.defaults.providerId ? local.defaults : (mirror.defaults ?? {});
    return {
        backend: 'unavailable',
        defaults,
        providers: [
            ...(mirror.providers ?? []).map(p => ({ ...p, origin: 'server' as const })),
            ...local.providers.map(p => ({ ...p, origin: 'local' as const })),
        ],
        mcpServers: [
            ...(mirror.mcpServers ?? []).map(s => ({ ...s, origin: 'server' as const })),
            ...local.mcpServers.map(s => ({ ...s, origin: 'local' as const })),
        ],
    };
}

// ------------------------------------------------------------------
// CRUD through the gateway
// ------------------------------------------------------------------

export interface ClientProviderInput {
    label: string;
    kind: AIProvider['kind'];
    baseUrl: string;
    connectionMode: AIProvider['connectionMode'];
    keyLocation: AIProvider['keyLocation'];
    /** Only sent to the server for keyLocation 'server'. */
    apiKey?: string;
    defaultModel?: string;
    pinnedModels?: string[];
    toolCalls: AIProvider['toolCalls'];
    enabled: boolean;
}

export async function createProviderRecord(input: ClientProviderInput): Promise<ClientProviderRecord> {
    const backend = await checkBackend();
    if (backend === 'available') {
        const response = await fetch('/api/ai/providers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
        });
        if (!response.ok) throw new Error(`Provider anlegen fehlgeschlagen (${response.status})`);
        const data = await response.json();
        return { ...data.provider, origin: 'server' };
    }

    // Serverless: keys can only live in the browser.
    const local = readLocalConfig();
    const now = new Date().toISOString();
    const record: Omit<AIProvider, 'apiKeyEnc'> = {
        id: newLocalId(),
        label: input.label,
        kind: input.kind,
        baseUrl: input.baseUrl,
        connectionMode: 'browser',
        keyLocation: input.keyLocation === 'server' ? 'browser' : input.keyLocation,
        defaultModel: input.defaultModel,
        pinnedModels: input.pinnedModels,
        toolCalls: input.toolCalls,
        enabled: input.enabled,
        createdAt: now,
        updatedAt: now,
    };
    local.providers.push(record);
    if (!local.defaults.providerId) {
        local.defaults = { providerId: record.id, model: record.defaultModel };
    }
    writeLocalConfig(local);
    return { ...record, origin: 'local' };
}

export async function updateProviderRecord(
    record: Pick<ClientProviderRecord, 'id' | 'origin'>,
    updates: Partial<ClientProviderInput>
): Promise<void> {
    if (record.origin === 'server') {
        const backend = await checkBackend();
        if (backend !== 'available') {
            throw new Error('Dieser Provider ist auf dem Server gespeichert — das Backend ist gerade nicht erreichbar.');
        }
        const response = await fetch(`/api/ai/providers/${encodeURIComponent(record.id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates),
        });
        if (!response.ok) throw new Error(`Provider aktualisieren fehlgeschlagen (${response.status})`);
        return;
    }
    const local = readLocalConfig();
    const index = local.providers.findIndex(p => p.id === record.id);
    if (index === -1) throw new Error('Provider nicht gefunden');
    const rest = { ...updates };
    delete rest.apiKey; // browser keys live in the key store, never in the config record
    local.providers[index] = {
        ...local.providers[index],
        ...rest,
        updatedAt: new Date().toISOString(),
    };
    writeLocalConfig(local);
}

export async function deleteProviderRecord(record: Pick<ClientProviderRecord, 'id' | 'origin'>): Promise<void> {
    if (record.origin === 'server') {
        const backend = await checkBackend();
        if (backend !== 'available') {
            throw new Error('Dieser Provider ist auf dem Server gespeichert — das Backend ist gerade nicht erreichbar.');
        }
        const response = await fetch(`/api/ai/providers/${encodeURIComponent(record.id)}`, { method: 'DELETE' });
        if (!response.ok) throw new Error(`Provider löschen fehlgeschlagen (${response.status})`);
        return;
    }
    const local = readLocalConfig();
    local.providers = local.providers.filter(p => p.id !== record.id);
    if (local.defaults.providerId === record.id) local.defaults = {};
    writeLocalConfig(local);
}

export async function saveDefaults(defaults: AIDefaults): Promise<void> {
    const backend = await checkBackend();
    if (backend === 'available') {
        const response = await fetch('/api/ai/defaults', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(defaults),
        });
        if (!response.ok) throw new Error(`Standard speichern fehlgeschlagen (${response.status})`);
        return;
    }
    const local = readLocalConfig();
    local.defaults = defaults;
    writeLocalConfig(local);
}

export interface ClientMcpInput {
    label: string;
    url: string;
    transport: McpServerConfig['transport'];
    connectionMode: McpServerConfig['connectionMode'];
    authHeaderName?: string;
    authHeaderValue?: string;
    enabled: boolean;
}

export async function createMcpRecord(input: ClientMcpInput): Promise<ClientMcpRecord> {
    const backend = await checkBackend();
    if (backend === 'available') {
        const response = await fetch('/api/ai/mcp-servers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
        });
        if (!response.ok) throw new Error(`MCP-Server anlegen fehlgeschlagen (${response.status})`);
        const data = await response.json();
        return { ...data.server, origin: 'server' };
    }
    const local = readLocalConfig();
    const now = new Date().toISOString();
    const record: Omit<McpServerConfig, 'authHeaderValueEnc'> = {
        id: newLocalId(),
        label: input.label,
        url: input.url,
        transport: input.transport,
        connectionMode: 'browser',
        authHeaderName: input.authHeaderName,
        enabled: input.enabled,
        createdAt: now,
        updatedAt: now,
    };
    local.mcpServers.push(record);
    writeLocalConfig(local);
    return { ...record, origin: 'local' };
}

export async function updateMcpRecord(
    record: Pick<ClientMcpRecord, 'id' | 'origin'>,
    updates: Partial<ClientMcpInput>
): Promise<void> {
    if (record.origin === 'server') {
        const backend = await checkBackend();
        if (backend !== 'available') {
            throw new Error('Dieser MCP-Server ist auf dem Server gespeichert — das Backend ist gerade nicht erreichbar.');
        }
        const response = await fetch(`/api/ai/mcp-servers/${encodeURIComponent(record.id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates),
        });
        if (!response.ok) throw new Error(`MCP-Server aktualisieren fehlgeschlagen (${response.status})`);
        return;
    }
    const local = readLocalConfig();
    const index = local.mcpServers.findIndex(s => s.id === record.id);
    if (index === -1) throw new Error('MCP-Server nicht gefunden');
    const rest = { ...updates };
    delete rest.authHeaderValue; // browser auth lives in the key store
    local.mcpServers[index] = {
        ...local.mcpServers[index],
        ...rest,
        updatedAt: new Date().toISOString(),
    };
    writeLocalConfig(local);
}

export async function deleteMcpRecord(record: Pick<ClientMcpRecord, 'id' | 'origin'>): Promise<void> {
    if (record.origin === 'server') {
        const backend = await checkBackend();
        if (backend !== 'available') {
            throw new Error('Dieser MCP-Server ist auf dem Server gespeichert — das Backend ist gerade nicht erreichbar.');
        }
        const response = await fetch(`/api/ai/mcp-servers/${encodeURIComponent(record.id)}`, { method: 'DELETE' });
        if (!response.ok) throw new Error(`MCP-Server löschen fehlgeschlagen (${response.status})`);
        return;
    }
    const local = readLocalConfig();
    local.mcpServers = local.mcpServers.filter(s => s.id !== record.id);
    writeLocalConfig(local);
}

// ------------------------------------------------------------------
// Route resolution — the heart of "cloud app, local inference"
// ------------------------------------------------------------------

export interface ResolvedRoute {
    decision: RouteDecision;
    /** Set when the browser executes the request itself. */
    resolved?: ResolvedProvider;
    probe?: ProbeResult;
}

/** Build a browser-context ResolvedProvider (key from browser storage). */
export function resolveBrowserProvider(record: ClientProviderRecord): ResolvedProvider {
    const provider: AIProvider = { ...record };
    return {
        provider,
        protocol: resolveProtocol(provider),
        apiKey: getBrowserProviderKey(record.id),
        context: 'browser',
    };
}

interface RouteCacheEntry {
    route: ResolvedRoute;
    ts: number;
}

const routeCache = new Map<string, RouteCacheEntry>();
const ROUTE_TTL_MS = 60_000;

export function invalidateRoute(providerId?: string): void {
    if (providerId) {
        routeCache.delete(providerId);
    } else {
        routeCache.clear();
    }
}

async function probeServerRoute(providerId: string): Promise<ProbeResult | null> {
    try {
        const response = await fetch(`/api/ai/providers/${encodeURIComponent(providerId)}/health`, { cache: 'no-store' });
        if (!response.ok) return null;
        return await response.json() as ProbeResult;
    } catch {
        return null;
    }
}

/**
 * Decide where requests for this provider run — and verify the path
 * actually works. 'auto' tries the browser first (that is the only path
 * that can ever reach the user's local machine), then falls back to the
 * server relay. Decisions are cached for a minute.
 */
export async function resolveRoute(record: ClientProviderRecord, force = false): Promise<ResolvedRoute> {
    const cached = routeCache.get(record.id);
    if (!force && cached && Date.now() - cached.ts < ROUTE_TTL_MS) return cached.route;

    const route = await computeRoute(record);
    routeCache.set(record.id, { route, ts: Date.now() });
    return route;
}

async function computeRoute(record: ClientProviderRecord): Promise<ResolvedRoute> {
    const backend = await checkBackend();
    const kindPreset = getPreset(record.kind);

    // WebLLM has exactly one home: this browser.
    if (kindPreset.protocol === 'webllm') {
        const resolved = resolveBrowserProvider(record);
        const probe = await probeProvider(resolved);
        return {
            decision: { route: 'browser', reason: 'WebLLM läuft direkt in diesem Browser (WebGPU).' },
            resolved,
            probe,
        };
    }

    const tryBrowser = async (): Promise<ResolvedRoute | null> => {
        // A server-stored key never reaches the browser: without a browser
        // key the direct route only works for keyless endpoints.
        if (record.keyLocation === 'server' && !getBrowserProviderKey(record.id)) {
            if (kindPreset.requiresKey) return null;
        }
        const resolved = resolveBrowserProvider(record);
        const probe = await probeProvider(resolved);
        if (probe.status === 'online' || probe.status === 'auth') {
            return {
                decision: {
                    route: 'browser',
                    reason: isPrivateUrl(record.baseUrl)
                        ? 'Direktverbindung: Der Browser erreicht den lokalen Endpunkt — unabhängig davon, wo die App gehostet ist.'
                        : 'Direktverbindung aus dem Browser.',
                },
                resolved,
                probe,
            };
        }
        return null;
    };

    const tryServer = async (): Promise<ResolvedRoute | null> => {
        if (backend !== 'available' || record.origin !== 'server') return null;
        const probe = await probeServerRoute(record.id);
        if (probe && (probe.status === 'online' || probe.status === 'auth')) {
            return {
                decision: { route: 'server', reason: 'Verbindung über das Workspace-Backend (Server-Route).' },
                probe,
            };
        }
        return null;
    };

    if (record.connectionMode === 'browser') {
        const viaBrowser = await tryBrowser();
        if (viaBrowser) return viaBrowser;
        const resolved = resolveBrowserProvider(record);
        return {
            decision: { route: 'browser', reason: 'Browser-Route erzwungen.' },
            resolved,
            probe: await probeProvider(resolved),
        };
    }

    if (record.connectionMode === 'server') {
        const viaServer = await tryServer();
        if (viaServer) return viaServer;
        return {
            decision: { route: 'server', reason: 'Server-Route erzwungen.' },
            probe: backend === 'available'
                ? (await probeServerRoute(record.id)) ?? { status: 'offline', detail: 'Server-Probe fehlgeschlagen.' }
                : { status: 'offline', detail: 'Kein Backend erreichbar — Server-Route nicht verfügbar. Stelle auf Browser-Route um oder hinterlege den Schlüssel im Browser.' },
        };
    }

    // auto: server-keyed cloud providers prefer the server (key stays there);
    // everything else prefers the direct browser path.
    const serverFirst = record.keyLocation === 'server' && !isPrivateUrl(record.baseUrl);
    const order = serverFirst ? [tryServer, tryBrowser] : [tryBrowser, tryServer];
    for (const attempt of order) {
        const result = await attempt();
        if (result) return result;
    }

    // Nothing worked — report the browser probe (most actionable hints).
    const resolved = resolveBrowserProvider(record);
    const probe = await probeProvider(resolved);
    return {
        decision: { route: 'browser', reason: 'Kein Pfad erreichbar — Diagnose zeigt den Browser-Versuch.' },
        resolved,
        probe,
    };
}
