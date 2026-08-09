import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { UIResourceContent } from '@/components/a2ui/types';

/**
 * Isomorphic MCP client (Model Context Protocol) over Streamable HTTP
 * with SSE fallback. Runs in the browser (direct connection, CORS
 * permitting) and on the server (relay for auth'd/CORS-blocked servers).
 *
 * stdio transports are intentionally out of scope: they require spawning
 * processes and exist only server-side — HTTP transports keep browser
 * and server paths equivalent.
 */

export interface McpEndpoint {
    url: string;
    transport: 'auto' | 'streamable-http' | 'sse';
    headers?: Record<string, string>;
    /**
     * Custom fetch for all transport requests. The graph connector injects
     * the SSRF-guarded connector fetch here; without it the transports use
     * the global fetch (browser/relay paths, unchanged behavior).
     */
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface McpToolDescriptor {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

export interface McpPromptDescriptor {
    name: string;
    title?: string;
    description: string;
}

export interface McpCallOutcome {
    text: string;
    isError: boolean;
    /** MCP-UI resources (ui:// URIs) contained in the result. */
    uiResources: UIResourceContent[];
}

const CLIENT_INFO = { name: 'open-workspace', version: '1.0.0' };

interface Connected {
    client: Client;
    /** Transport that actually connected (relevant for 'auto'). */
    transport: 'streamable-http' | 'sse';
}

async function connect(endpoint: McpEndpoint): Promise<Connected> {
    const url = new URL(endpoint.url);
    const requestInit: RequestInit | undefined = endpoint.headers && Object.keys(endpoint.headers).length > 0
        ? { headers: endpoint.headers }
        : undefined;
    const fetchOption = endpoint.fetchImpl
        ? (input: string | URL, init?: RequestInit) => endpoint.fetchImpl!(String(input), init)
        : undefined;

    const attempt = async (kind: 'streamable-http' | 'sse'): Promise<Connected> => {
        const client = new Client(CLIENT_INFO);
        const transport = kind === 'streamable-http'
            ? new StreamableHTTPClientTransport(url, { requestInit, fetch: fetchOption })
            : new SSEClientTransport(url, { requestInit, fetch: fetchOption });
        await client.connect(transport);
        return { client, transport: kind };
    };

    if (endpoint.transport === 'streamable-http') return attempt('streamable-http');
    if (endpoint.transport === 'sse') return attempt('sse');
    try {
        return await attempt('streamable-http');
    } catch (error) {
        try {
            return await attempt('sse');
        } catch {
            throw error; // report the primary transport's error
        }
    }
}

async function withClient<T>(endpoint: McpEndpoint, fn: (client: Client, transport: 'streamable-http' | 'sse') => Promise<T>): Promise<T> {
    const { client, transport } = await connect(endpoint);
    try {
        return await fn(client, transport);
    } finally {
        await client.close().catch(() => undefined);
    }
}

export async function listMcpTools(endpoint: McpEndpoint): Promise<McpToolDescriptor[]> {
    return withClient(endpoint, async client => {
        const result = await client.listTools();
        return (result.tools ?? []).map(tool => ({
            name: tool.name,
            description: tool.description ?? '',
            inputSchema: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object' },
        }));
    });
}

interface McpContentPart {
    type: string;
    text?: string;
    resource?: { uri?: string; mimeType?: string; text?: string; blob?: string };
}

/** Flatten an MCP tool result into text + any embedded ui:// resources. */
export function extractCallOutcome(result: { content?: unknown; isError?: boolean }): McpCallOutcome {
    const parts = Array.isArray(result.content) ? (result.content as McpContentPart[]) : [];
    const texts: string[] = [];
    const uiResources: UIResourceContent[] = [];

    for (const part of parts) {
        if (part.type === 'text' && part.text) {
            texts.push(part.text);
        } else if (part.type === 'resource' && part.resource) {
            const resource: UIResourceContent = {
                uri: part.resource.uri,
                mimeType: part.resource.mimeType,
                text: part.resource.text,
                blob: part.resource.blob,
            };
            if (resource.uri?.startsWith('ui://')) {
                uiResources.push(resource);
                texts.push(`[UI-Ressource geliefert: ${resource.uri}]`);
            } else if (part.resource.text) {
                texts.push(part.resource.text);
            }
        } else if (part.type === 'image') {
            texts.push('[Bild-Inhalt]');
        }
    }

    return {
        text: texts.join('\n') || '(leeres Ergebnis)',
        isError: Boolean(result.isError),
        uiResources,
    };
}

export async function callMcpTool(
    endpoint: McpEndpoint,
    name: string,
    args: Record<string, unknown>
): Promise<McpCallOutcome> {
    return withClient(endpoint, async client => {
        const result = await client.callTool({ name, arguments: args });
        return extractCallOutcome(result as { content?: unknown; isError?: boolean });
    });
}

export async function listMcpPrompts(endpoint: McpEndpoint): Promise<McpPromptDescriptor[]> {
    return withClient(endpoint, async client => {
        try {
            const result = await client.listPrompts();
            return (result.prompts ?? []).map(prompt => ({
                name: prompt.name,
                title: (prompt as { title?: string }).title,
                description: prompt.description ?? '',
            }));
        } catch {
            return []; // server has no prompts capability
        }
    });
}

/** Fetch a prompt's messages and flatten them to markdown (skill import). */
export async function getMcpPromptText(
    endpoint: McpEndpoint,
    name: string,
    args?: Record<string, string>
): Promise<string> {
    return withClient(endpoint, async client => {
        const result = await client.getPrompt({ name, arguments: args ?? {} });
        const lines: string[] = [];
        for (const message of result.messages ?? []) {
            const content = message.content as { type?: string; text?: string };
            if (content?.type === 'text' && content.text) {
                lines.push(content.text);
            }
        }
        return lines.join('\n\n');
    });
}

export interface McpInventory {
    server: { name?: string; version?: string };
    /** Transport that actually connected (relevant for 'auto'). */
    transport: 'streamable-http' | 'sse';
    tools: McpToolDescriptor[];
    prompts: McpPromptDescriptor[];
}

/**
 * Full inventory (server info, tools, prompts) over a single connection —
 * used by the `mcp-server` graph connector to materialize the server as
 * ow:ToolProvider with ow:Tool/ow:Skill nodes (M9).
 */
export async function describeMcpServer(endpoint: McpEndpoint): Promise<McpInventory> {
    return withClient(endpoint, async (client, transport) => {
        const serverInfo = client.getServerVersion();
        // Capability-gated, not try/catch: a prompts-only (or tools-only)
        // server yields an honest empty list, while a failing list call on
        // an advertised capability stays a real error (no silently empty
        // inventory replacing a previous good import).
        const capabilities = client.getServerCapabilities();
        let tools: McpToolDescriptor[] = [];
        if (capabilities?.tools) {
            const toolsResult = await client.listTools();
            tools = (toolsResult.tools ?? []).map(tool => ({
                name: tool.name,
                description: tool.description ?? '',
                inputSchema: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object' },
            }));
        }
        let prompts: McpPromptDescriptor[] = [];
        if (capabilities?.prompts) {
            const promptsResult = await client.listPrompts();
            prompts = (promptsResult.prompts ?? []).map(prompt => ({
                name: prompt.name,
                title: (prompt as { title?: string }).title,
                description: prompt.description ?? '',
            }));
        }
        return {
            server: {
                name: typeof serverInfo?.name === 'string' ? serverInfo.name : undefined,
                version: typeof serverInfo?.version === 'string' ? serverInfo.version : undefined,
            },
            transport,
            tools,
            prompts,
        };
    });
}

/** Cheap connectivity probe (initialize handshake only). */
export async function probeMcp(endpoint: McpEndpoint): Promise<{ ok: boolean; detail: string; toolCount?: number }> {
    try {
        const tools = await listMcpTools(endpoint);
        return { ok: true, detail: `Verbunden — ${tools.length} Tools.`, toolCount: tools.length };
    } catch (error) {
        return {
            ok: false,
            detail: error instanceof Error ? error.message : 'Verbindung fehlgeschlagen',
        };
    }
}
