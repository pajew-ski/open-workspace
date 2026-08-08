'use client';

import type { Tool } from '@/lib/tools/types';
import type { Agent } from '@/lib/agents/types';
import type { EngineTool, EngineToolResult } from '@/lib/ai/engine';
import type { PromptAgentInfo } from '@/lib/ai/prompt';
import type { SkillMeta } from '@/lib/skills/types';
import { toSkillMeta } from '@/lib/skills/types';
import { checkBackend } from '@/lib/platform/backend';
import { listClientSkills } from '@/lib/skills/store.client';
import { apiToolToEngineTool, makeFinderTool, makeUseSkillTool, mcpToolsToEngineTools } from '@/lib/ai/tools.shared';
import {
    listMcpTools,
    callMcpTool,
    listMcpPrompts,
    getMcpPromptText,
    probeMcp,
    type McpEndpoint,
    type McpCallOutcome,
    type McpPromptDescriptor,
} from '@/lib/ai/mcp/client';
import { sendA2AMessage } from '@/lib/ai/a2a/client';
import { getBrowserMcpAuth } from '@/lib/ai/keys.client';
import { streamProviderChat } from '@/lib/ai/client';
import { resolveBrowserProvider, resolveRoute, type ClientAIState, type ClientMcpRecord } from '@/lib/ai/store.client';

/**
 * Browser-side engine dependencies — the mirror image of
 * src/lib/ai/server/deps.ts for the serverless / direct-connection path:
 *
 * - workspace finder & credentialed API tools use the backend when it is
 *   reachable and degrade honestly when it is not
 * - MCP servers are contacted directly from the browser (with relay
 *   fallback), so local and CORS-enabled servers work without a backend
 * - agents: local personas run on browser-routed providers, remote A2A
 *   agents are called directly (relay when credentials live server-side)
 */

const MIRROR_TOOLS = 'ow.tools.mirror';
const MIRROR_AGENTS = 'ow.agents.mirror';

function readMirror<T>(key: string): T[] {
    if (typeof window === 'undefined') return [];
    try {
        const raw = window.localStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeMirror(key: string, value: unknown[]): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(key, JSON.stringify(value));
    } catch { /* best effort */ }
}

async function fetchWithMirror<T>(url: string, listKey: string, mirrorKey: string): Promise<T[]> {
    if ((await checkBackend()) === 'available') {
        try {
            const response = await fetch(url, { cache: 'no-store' });
            if (response.ok) {
                const data = await response.json();
                const list: T[] = data[listKey] ?? [];
                writeMirror(mirrorKey, list);
                return list;
            }
        } catch { /* fall back */ }
    }
    return readMirror<T>(mirrorKey);
}

// ------------------------------------------------------------------
// MCP from the browser (direct first, relay fallback)
// ------------------------------------------------------------------

const mcpToolCache = new Map<string, { tools: EngineTool[]; ts: number }>();
const MCP_CACHE_TTL_MS = 60_000;

export function invalidateBrowserMcpCache(serverId?: string): void {
    if (serverId) {
        mcpToolCache.delete(serverId);
    } else {
        mcpToolCache.clear();
    }
}

function browserEndpoint(record: ClientMcpRecord): McpEndpoint {
    const authValue = getBrowserMcpAuth(record.id);
    const headers: Record<string, string> = {};
    if (record.authHeaderName && authValue) headers[record.authHeaderName] = authValue;
    return { url: record.url, transport: record.transport, headers };
}

async function relayMcp<T>(serverId: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`/api/ai/mcp/${encodeURIComponent(serverId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `MCP-Relay: HTTP ${response.status}`);
    }
    return response.json();
}

/** Discover the engine tools of one MCP server from the browser. */
export async function browserMcpTools(record: ClientMcpRecord): Promise<EngineTool[]> {
    const cached = mcpToolCache.get(record.id);
    if (cached && Date.now() - cached.ts < MCP_CACHE_TTL_MS) return cached.tools;

    const backend = (await checkBackend()) === 'available';
    const canRelay = backend && record.origin === 'server' && record.connectionMode !== 'browser';

    const buildDirect = async (): Promise<EngineTool[]> => {
        const endpoint = browserEndpoint(record);
        const descriptors = await listMcpTools(endpoint);
        return mcpToolsToEngineTools(record.id, record.label, descriptors, async (name, args) => {
            try {
                return await callMcpTool(endpoint, name, args);
            } catch (error) {
                if (canRelay) {
                    return relayMcp<McpCallOutcome>(record.id, { op: 'callTool', name, args });
                }
                throw error;
            }
        });
    };

    const buildRelayed = async (): Promise<EngineTool[]> => {
        const data = await relayMcp<{ tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> }>(
            record.id,
            { op: 'listTools' }
        );
        return mcpToolsToEngineTools(record.id, record.label, data.tools, (name, args) =>
            relayMcp<McpCallOutcome>(record.id, { op: 'callTool', name, args })
        );
    };

    let tools: EngineTool[] = [];
    if (record.connectionMode === 'server') {
        if (!canRelay) return [];
        tools = await buildRelayed();
    } else {
        try {
            tools = await buildDirect();
        } catch (error) {
            if (canRelay) {
                tools = await buildRelayed();
            } else {
                throw error;
            }
        }
    }

    mcpToolCache.set(record.id, { tools, ts: Date.now() });
    return tools;
}

/** Probe an MCP server from the browser (direct, relay fallback). */
export async function probeMcpRecord(record: ClientMcpRecord): Promise<{ ok: boolean; detail: string; toolCount?: number; via: 'browser' | 'server' }> {
    const backend = (await checkBackend()) === 'available';
    const canRelay = backend && record.origin === 'server' && record.connectionMode !== 'browser';

    if (record.connectionMode !== 'server') {
        const direct = await probeMcp(browserEndpoint(record));
        if (direct.ok || !canRelay) return { ...direct, via: 'browser' };
    }
    if (canRelay) {
        try {
            const result = await relayMcp<{ ok: boolean; detail: string; toolCount?: number }>(record.id, { op: 'probe' });
            return { ...result, via: 'server' };
        } catch (error) {
            return { ok: false, detail: error instanceof Error ? error.message : 'Relay fehlgeschlagen', via: 'server' };
        }
    }
    return { ok: false, detail: 'Kein Verbindungspfad verfügbar (Server-Modus ohne erreichbares Backend).', via: 'server' };
}

/** List an MCP server's prompts from the browser (direct, relay fallback). */
export async function browserMcpPrompts(record: ClientMcpRecord): Promise<McpPromptDescriptor[]> {
    const backend = (await checkBackend()) === 'available';
    const canRelay = backend && record.origin === 'server' && record.connectionMode !== 'browser';

    if (record.connectionMode !== 'server') {
        try {
            return await listMcpPrompts(browserEndpoint(record));
        } catch (error) {
            if (!canRelay) throw error;
        }
    }
    if (canRelay) {
        const data = await relayMcp<{ prompts: McpPromptDescriptor[] }>(record.id, { op: 'listPrompts' });
        return data.prompts;
    }
    return [];
}

/** Fetch a prompt's flattened text (skill import) from the browser. */
export async function browserMcpPromptText(record: ClientMcpRecord, name: string): Promise<string> {
    const backend = (await checkBackend()) === 'available';
    const canRelay = backend && record.origin === 'server' && record.connectionMode !== 'browser';

    if (record.connectionMode !== 'server') {
        try {
            return await getMcpPromptText(browserEndpoint(record), name);
        } catch (error) {
            if (!canRelay) throw error;
        }
    }
    if (canRelay) {
        const data = await relayMcp<{ text: string }>(record.id, { op: 'getPrompt', name });
        return data.text;
    }
    throw new Error('Kein Verbindungspfad verfügbar.');
}

// ------------------------------------------------------------------
// Building the full dependency set
// ------------------------------------------------------------------

export interface BrowserEngineDeps {
    tools: EngineTool[];
    skills: SkillMeta[];
    agents: PromptAgentInfo[];
    callAgent: (agentId: string, prompt: string) => Promise<string>;
}

export async function buildBrowserEngineDeps(state: ClientAIState): Promise<BrowserEngineDeps> {
    const backend = (await checkBackend()) === 'available';

    const [apiTools, agents, clientSkills] = await Promise.all([
        fetchWithMirror<Tool>('/api/tools', 'tools', MIRROR_TOOLS),
        fetchWithMirror<Agent>('/api/agents', 'agents', MIRROR_AGENTS),
        listClientSkills(),
    ]);

    const enabledSkills = clientSkills.filter(s => s.enabled);
    const skillMetas = enabledSkills.map(toSkillMeta);

    const tools: EngineTool[] = [
        makeFinderTool(async (query, type) => {
            if (!backend) {
                return 'Die Workspace-Suche benötigt das Workspace-Backend, das gerade nicht erreichbar ist.';
            }
            const url = new URL('/api/finder', window.location.origin);
            url.searchParams.set('q', query);
            if (type) url.searchParams.set('type', type);
            const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            if (!res.ok) return `Fehler: Finder antwortete mit Status ${res.status}.`;
            const data = await res.json();
            const results = (data.results || []).slice(0, 10);
            return results.length === 0 ? `Keine Treffer für "${query}".` : JSON.stringify(results);
        }),
    ];

    // API tools: server execution (credentials) when possible, direct
    // browser fetch as the serverless fallback (CORS permitting).
    for (const tool of apiTools.filter(t => t.enabled && t.type === 'api')) {
        tools.push(apiToolToEngineTool(tool, async (t, args): Promise<EngineToolResult> => {
            if (backend) {
                const response = await fetch('/api/tools/execute', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ toolId: t.id, args }),
                });
                const result = await response.json();
                if (!response.ok || result.success === false) {
                    return { text: `Fehler: ${result.error ?? `HTTP ${response.status}`}` };
                }
                return { text: typeof result.data === 'string' ? result.data : JSON.stringify(result.data) };
            }
            return executeApiToolInBrowser(t, args);
        }));
    }

    // MCP servers (per-server failures must not break the chat).
    for (const server of state.mcpServers.filter(s => s.enabled)) {
        try {
            tools.push(...await browserMcpTools(server));
        } catch (error) {
            console.warn(`[mcp] Server "${server.label}" nicht erreichbar (Browser):`, error instanceof Error ? error.message : error);
        }
    }

    if (skillMetas.length > 0) {
        tools.push(makeUseSkillTool(skillMetas, async id => {
            const skill = enabledSkills.find(s => s.id === id);
            return skill?.content ?? null;
        }));
    }

    const enabledAgents = agents.filter(a => a.enabled);

    return {
        tools,
        skills: skillMetas,
        agents: enabledAgents.map(a => ({ id: a.id, name: a.name, description: a.description, type: a.type })),
        callAgent: (agentId, prompt) => callAgentFromBrowser(state, enabledAgents, agentId, prompt, backend),
    };
}

/** Direct browser execution of an API tool (serverless fallback, no stored credentials). */
async function executeApiToolInBrowser(tool: Tool, args: Record<string, unknown>): Promise<EngineToolResult> {
    if (tool.connectionId) {
        return { text: 'Fehler: Dieses Tool nutzt eine gesicherte Verbindung — die Zugangsdaten liegen auf dem Server, der gerade nicht erreichbar ist.' };
    }
    let url = tool.config.url || '';
    Object.entries(args).forEach(([key, value]) => {
        url = url.split(`{${key}}`).join(encodeURIComponent(String(value)));
    });
    let body = tool.config.body;
    if (body) {
        Object.entries(args).forEach(([key, value]) => {
            body = body!.split(`{${key}}`).join(JSON.stringify(value).replace(/^"|"$/g, ''));
        });
    }
    const method = tool.config.method || 'GET';
    try {
        const response = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json', ...tool.config.headers },
            body: method !== 'GET' ? body : undefined,
            signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) return { text: `Fehler: API antwortete mit ${response.status}` };
        const data = await response.json().catch(() => null);
        return { text: data === null ? 'OK (keine JSON-Antwort)' : JSON.stringify(data) };
    } catch (error) {
        return {
            text: `Fehler: ${error instanceof Error ? error.message : 'Netzwerkfehler'} — mögliche Ursache: CORS. Mit erreichbarem Backend würde dieses Tool über den Server laufen.`,
        };
    }
}

/** Delegate to an agent from the browser context. */
async function callAgentFromBrowser(
    state: ClientAIState,
    agents: Agent[],
    agentId: string,
    prompt: string,
    backend: boolean
): Promise<string> {
    const agent = agents.find(a => a.id === agentId || a.name === agentId);
    if (!agent) return `Fehler: Agent "${agentId}" existiert nicht oder ist deaktiviert.`;

    if (agent.type === 'remote_a2a') {
        // Credentials for A2A live server-side → prefer the relay.
        if (backend) {
            const response = await fetch('/api/ai/a2a', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ op: 'send', agentId: agent.id, prompt }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || `A2A-Relay: HTTP ${response.status}`);
            return data.reply ?? '(keine Antwort)';
        }
        if (!agent.config.endpointUrl) {
            return `Fehler: Für Agent "${agent.name}" ist kein A2A-Endpunkt konfiguriert.`;
        }
        return sendA2AMessage(agent.config.endpointUrl, prompt);
    }

    // Local persona agent on a browser-routed provider.
    const record = (agent.config.providerId
        ? state.providers.find(p => p.id === agent.config.providerId)
        : undefined)
        ?? state.providers.find(p => p.id === state.defaults.providerId)
        ?? state.providers.find(p => p.enabled);
    if (!record) return 'Fehler: Kein Inference-Provider konfiguriert.';

    const route = await resolveRoute(record);
    if (route.decision.route === 'server' && backend) {
        // Use the server chat route in non-streaming mode as sub-call.
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: [{ role: 'user', content: prompt }],
                context: {
                    module: `Agent:${agent.name}`,
                    moduleDescription: agent.config.systemPrompt || agent.description,
                    pathname: '/agents',
                },
                stream: false,
                providerId: record.id,
                model: agent.config.model,
            }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        return data.message?.content ?? '(keine Antwort)';
    }

    const resolved = route.resolved ?? resolveBrowserProvider(record);
    let text = '';
    for await (const event of streamProviderChat(resolved, {
        model: agent.config.model,
        messages: [
            {
                role: 'system',
                content: agent.config.systemPrompt || `Du bist der Agent „${agent.name}": ${agent.description}. Antworte präzise auf Deutsch.`,
            },
            { role: 'user', content: prompt },
        ],
    })) {
        if (event.type === 'text') text += event.text;
    }
    return text || '(Der Agent hat keine Antwort geliefert.)';
}
