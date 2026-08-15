import { loadTools } from '@/lib/tools/storage';
import { executeTool } from '@/lib/tools/executor';
import { loadAgents } from '@/lib/agents/storage';
import { loadSkills } from '@/lib/skills/store.server';
import { getConnectionWithSecrets } from '@/lib/connections/manager';
import { loadAIConfig, resolveMcpServerAuth, resolveDefaultServerProvider, resolveServerProvider } from '@/lib/ai/store.server';
import { listMcpTools, callMcpTool } from '@/lib/ai/mcp/client';
import { sendA2AMessage } from '@/lib/ai/a2a/client';
import { streamProviderChat } from '@/lib/ai/client';
import {
    apiToolToEngineTool,
    makeCreateTaskTool,
    makeFinderTool,
    makeUpdateTaskTool,
    makeUseSkillTool,
    mcpToolsToEngineTools,
    type TaskToolFields,
} from '@/lib/ai/tools.shared';
import type { EngineTool } from '@/lib/ai/engine';
import type { PromptAgentInfo } from '@/lib/ai/prompt';
import type { SkillMeta } from '@/lib/skills/types';
import { toSkillMeta } from '@/lib/skills/types';
import type { Agent } from '@/lib/agents/types';
import { createTaskSchema, updateTaskSchema } from '@/lib/api/validation';

/**
 * Server-side engine dependencies: assembles the tool belt (built-ins,
 * API tools, MCP tools), skills and delegable agents for a chat turn
 * executed on the backend.
 */

/** Discovered MCP tool lists are cached briefly so chat turns start fast. */
const mcpCache = new Map<string, { tools: EngineTool[]; ts: number }>();
const MCP_CACHE_TTL_MS = 60_000;
const MCP_LIST_TIMEOUT_MS = 8_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label}: Timeout nach ${ms}ms`)), ms)),
    ]);
}

async function collectMcpTools(): Promise<EngineTool[]> {
    const config = await loadAIConfig();
    const servers = config.mcpServers.filter(s => s.enabled && s.connectionMode !== 'browser');
    const results: EngineTool[] = [];

    await Promise.all(servers.map(async server => {
        const cached = mcpCache.get(server.id);
        if (cached && Date.now() - cached.ts < MCP_CACHE_TTL_MS) {
            results.push(...cached.tools);
            return;
        }
        try {
            const auth = await resolveMcpServerAuth(server.id);
            const endpoint = { url: server.url, transport: server.transport, headers: auth?.headers };
            const descriptors = await withTimeout(listMcpTools(endpoint), MCP_LIST_TIMEOUT_MS, server.label);
            const tools = mcpToolsToEngineTools(
                server.id,
                server.label,
                descriptors,
                (toolName, args) => callMcpTool(endpoint, toolName, args)
            );
            mcpCache.set(server.id, { tools, ts: Date.now() });
            results.push(...tools);
        } catch (error) {
            console.error(`[mcp] Server "${server.label}" nicht erreichbar:`, error instanceof Error ? error.message : error);
        }
    }));

    return results;
}

export function invalidateMcpToolCache(serverId?: string): void {
    if (serverId) {
        mcpCache.delete(serverId);
    } else {
        mcpCache.clear();
    }
}

async function runFinder(query: string, type: string | undefined, origin: string): Promise<string> {
    const url = new URL('/api/finder', origin);
    url.searchParams.set('q', query);
    if (type) url.searchParams.set('type', type);
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return `Fehler: Finder antwortete mit Status ${res.status}.`;
    const data = await res.json();
    const results = (data.results || []).slice(0, 10);
    if (results.length === 0) return `Keine Treffer für "${query}".`;
    return JSON.stringify(results);
}

/**
 * Aufgaben-Tools schreiben serverseitig über die Storage-Fassade statt
 * über einen zweiten HTTP-Aufruf an die eigene Route: Der Chat-Turn läuft
 * bereits im Request des Nutzers, und `getWorkspaceContext()` zieht seine
 * Identität von dort. Ein Fetch auf `/api/tasks` käme ohne die
 * Identitäts-Header an und schriebe anonym in den falschen Nutzergraphen.
 * Geprüft wird trotzdem mit denselben Zod-Schemas wie an der Route — die
 * Argumente kommen von einem Sprachmodell.
 */
async function runCreateTask(fields: TaskToolFields): Promise<string> {
    const parsed = createTaskSchema.safeParse(fields);
    if (!parsed.success) {
        return `Fehler: ${parsed.error.issues.map(i => `${i.path.join('.') || 'Eingabe'}: ${i.message}`).join('; ')}`;
    }
    try {
        const { createTask } = await import('@/lib/storage');
        const task = await createTask(parsed.data);
        const { logActivity } = await import('@/lib/activity');
        await logActivity('task_created', task.id, `Aufgabe erstellt: ${task.title}`);
        return `Aufgabe "${task.title}" angelegt (ID ${task.id}, Status ${task.status}, Priorität ${task.priority}).`;
    } catch (error) {
        return `Fehler beim Anlegen der Aufgabe: ${error instanceof Error ? error.message : 'unbekannt'}`;
    }
}

async function runUpdateTask(taskId: string, fields: TaskToolFields): Promise<string> {
    const parsed = updateTaskSchema.safeParse(fields);
    if (!parsed.success) {
        return `Fehler: ${parsed.error.issues.map(i => `${i.path.join('.') || 'Eingabe'}: ${i.message}`).join('; ')}`;
    }
    try {
        const { updateTask } = await import('@/lib/storage');
        const task = await updateTask(taskId, parsed.data);
        if (!task) return `Fehler: Aufgabe "${taskId}" existiert nicht.`;
        const { logActivity } = await import('@/lib/activity');
        await logActivity('task_updated', task.id, `Aufgabe geändert: ${task.title}`);
        return `Aufgabe "${task.title}" geändert (ID ${task.id}, Status ${task.status}, Priorität ${task.priority}).`;
    } catch (error) {
        return `Fehler beim Ändern der Aufgabe: ${error instanceof Error ? error.message : 'unbekannt'}`;
    }
}

export interface ServerEngineDeps {
    tools: EngineTool[];
    skills: SkillMeta[];
    agents: PromptAgentInfo[];
    callAgent: (agentId: string, prompt: string) => Promise<string>;
}

export async function buildServerEngineDeps(origin: string): Promise<ServerEngineDeps> {
    const [apiTools, skills, agents, mcpTools] = await Promise.all([
        loadTools(),
        loadSkills(),
        loadAgents(),
        collectMcpTools(),
    ]);

    const enabledSkills = skills.filter(s => s.enabled);
    const skillMetas = enabledSkills.map(toSkillMeta);

    const tools: EngineTool[] = [
        makeFinderTool((query, type) => runFinder(query, type, origin)),
        makeCreateTaskTool(runCreateTask),
        makeUpdateTaskTool(runUpdateTask),
        ...apiTools.filter(t => t.enabled && t.type === 'api').map(tool =>
            apiToolToEngineTool(tool, async (t, args) => {
                const result = await executeTool(t, args as Record<string, unknown>);
                if (!result.success) return { text: `Fehler: ${result.error ?? 'unbekannt'}` };
                return { text: typeof result.data === 'string' ? result.data : JSON.stringify(result.data) };
            })
        ),
        ...mcpTools,
    ];
    if (skillMetas.length > 0) {
        tools.push(makeUseSkillTool(skillMetas, async id => {
            const skill = enabledSkills.find(s => s.id === id);
            return skill?.content ?? null;
        }));
    }

    const enabledAgents = agents.filter(a => a.enabled);
    const agentInfos: PromptAgentInfo[] = enabledAgents.map(a => ({
        id: a.id,
        name: a.name,
        description: a.description,
        type: a.type,
    }));

    return {
        tools,
        skills: skillMetas,
        agents: agentInfos,
        callAgent: (agentId, prompt) => callServerAgent(enabledAgents, agentId, prompt),
    };
}

/** Delegate to a local (persona) or remote (A2A) agent, server-side. */
async function callServerAgent(agents: Agent[], agentId: string, prompt: string): Promise<string> {
    const agent = agents.find(a => a.id === agentId || a.name === agentId);
    if (!agent) return `Fehler: Agent "${agentId}" existiert nicht oder ist deaktiviert.`;

    if (agent.type === 'remote_a2a') {
        let endpointUrl = agent.config.endpointUrl;
        const headers: Record<string, string> = {};
        if (agent.connectionId) {
            const connection = await getConnectionWithSecrets(agent.connectionId);
            if (connection) {
                endpointUrl = endpointUrl || connection.baseUrl;
                if (connection.auth.type === 'bearer' && connection.auth.token) {
                    headers['Authorization'] = `Bearer ${connection.auth.token}`;
                } else if (connection.auth.type === 'apikey' && connection.auth.apiKey && connection.auth.headerName) {
                    headers[connection.auth.headerName] = connection.auth.apiKey;
                }
            }
        }
        if (!endpointUrl) return `Fehler: Für Agent "${agent.name}" ist kein A2A-Endpunkt konfiguriert.`;
        return sendA2AMessage(endpointUrl, prompt, headers);
    }

    // Local persona agent: one focused round on its provider/model, no tools.
    const resolved = agent.config.providerId
        ? await resolveServerProvider(agent.config.providerId)
        : (await resolveDefaultServerProvider())?.resolved ?? null;
    if (!resolved) return 'Fehler: Kein Inference-Provider für lokale Agenten konfiguriert.';
    if (resolved.protocol === 'webllm') return 'Fehler: Dieser Agent nutzt WebLLM und kann nur im Browser laufen.';

    const messages = [
        {
            role: 'system' as const,
            content: agent.config.systemPrompt || `Du bist der Agent „${agent.name}": ${agent.description}. Antworte präzise auf Deutsch.`,
        },
        { role: 'user' as const, content: prompt },
    ];

    let text = '';
    for await (const event of streamProviderChat(resolved, { model: agent.config.model, messages })) {
        if (event.type === 'text') text += event.text;
    }
    return text || '(Der Agent hat keine Antwort geliefert.)';
}
