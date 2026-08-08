/**
 * Core types of the AI platform layer.
 *
 * Everything in src/lib/ai/ is isomorphic: it runs in the browser AND on
 * the server. Which side actually executes a request ("route") is decided
 * per provider at runtime — that is what makes the workspace independent
 * of its own backend:
 *
 * - route "browser": the browser talks directly to the inference endpoint
 *   (local Ollama/LM Studio, CORS-enabled cloud APIs, or in-browser WebLLM).
 *   Works even when the app is statically hosted or the backend is gone.
 * - route "server": the Next.js backend relays the request (needed when an
 *   API key must stay server-side, or when CORS blocks the browser).
 */

/** Wire protocol an endpoint speaks. */
export type ProviderProtocol = 'openai' | 'anthropic' | 'ollama' | 'webllm';

/** Catalog identifier — determines protocol, defaults and UI copy. */
export type ProviderKind =
    | 'ollama'
    | 'lmstudio'
    | 'llamacpp'
    | 'vllm'
    | 'jan'
    | 'webllm'
    | 'openai'
    | 'anthropic'
    | 'google'
    | 'mistral'
    | 'groq'
    | 'openrouter'
    | 'together'
    | 'deepseek'
    | 'xai'
    | 'custom';

/** Where a request is executed. 'auto' probes browser first, then server. */
export type ConnectionMode = 'auto' | 'browser' | 'server';

/** Where the API key is stored. */
export type KeyLocation = 'none' | 'server' | 'browser';

/** How tool calls are made against this provider. */
export type ToolCallMode = 'auto' | 'native' | 'text';

export interface AIProvider {
    id: string;
    label: string;
    kind: ProviderKind;
    /** Base URL of the endpoint. Empty for kind 'webllm'. */
    baseUrl: string;
    connectionMode: ConnectionMode;
    keyLocation: KeyLocation;
    /**
     * Server-side only: encrypted API key (AES-256-GCM) or "ENV:VAR_NAME"
     * reference. Never serialized to the client.
     */
    apiKeyEnc?: string;
    /** Client-facing flag: a server-side key exists (the key itself never leaves the server). */
    hasServerKey?: boolean;
    defaultModel?: string;
    /** Manually pinned models (used when the endpoint cannot list models). */
    pinnedModels?: string[];
    toolCalls: ToolCallMode;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
}

/** A provider ready for execution: key resolved, route decided. */
export interface ResolvedProvider {
    provider: AIProvider;
    protocol: ProviderProtocol;
    apiKey?: string;
    /** The context this resolution is valid for. */
    context: 'browser' | 'server';
}

export interface AIDefaults {
    providerId?: string;
    model?: string;
}

/** MCP server registration. */
export interface McpServerConfig {
    id: string;
    label: string;
    /** Streamable-HTTP (or legacy SSE) endpoint URL. */
    url: string;
    transport: 'auto' | 'streamable-http' | 'sse';
    connectionMode: ConnectionMode;
    /** Optional static auth header, e.g. { name: 'Authorization', value: 'Bearer …' }. */
    authHeaderName?: string;
    /** Server-side: encrypted value or ENV: reference. */
    authHeaderValueEnc?: string;
    hasServerAuth?: boolean;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
}

/** The persisted AI platform configuration (server: data/ai/config.json). */
export interface AIConfig {
    version: 1;
    defaults: AIDefaults;
    providers: AIProvider[];
    mcpServers: McpServerConfig[];
}

// ------------------------------------------------------------------
// Chat / engine wire types
// ------------------------------------------------------------------

export interface EngineToolCall {
    id: string;
    name: string;
    /** JSON-serialized arguments (kept as string until execution). */
    args: string;
}

export interface EngineMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    /** Native tool calls issued by an assistant turn. */
    toolCalls?: EngineToolCall[];
    /** For role 'tool': which call this result answers. */
    toolCallId?: string;
    toolName?: string;
}

export interface ChatRequestOptions {
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
}

/** JSON-Schema-ish tool declaration handed to adapters for native calling. */
export interface ToolSpec {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

/** Normalized streaming events every protocol adapter emits. */
export type AdapterEvent =
    | { type: 'text'; text: string }
    | { type: 'toolCall'; call: EngineToolCall }
    | { type: 'done'; model?: string }
    /** Progress for engines with load phases (WebLLM download/compile). */
    | { type: 'progress'; label: string; value?: number };

export interface AdapterRequest {
    baseUrl: string;
    apiKey?: string;
    model: string;
    messages: EngineMessage[];
    /** When set, the adapter should attempt native tool calling. */
    tools?: ToolSpec[];
    options?: ChatRequestOptions;
    signal?: AbortSignal;
    /** True when executing inside a browser (enables e.g. Anthropic CORS opt-in header). */
    inBrowser?: boolean;
}

export interface ProtocolAdapter {
    protocol: ProviderProtocol;
    /** True if the adapter can express ToolSpecs natively on the wire. */
    supportsNativeTools: boolean;
    streamChat(req: AdapterRequest): AsyncGenerator<AdapterEvent, void, unknown>;
    listModels(req: Pick<AdapterRequest, 'baseUrl' | 'apiKey' | 'signal' | 'inBrowser'>): Promise<string[]>;
}

// ------------------------------------------------------------------
// Probing / diagnostics
// ------------------------------------------------------------------

export type ProbeStatus =
    | 'online'
    /** Endpoint reachable but rejected credentials. */
    | 'auth'
    /** Browser fetch failed although the URL may be fine — typically CORS. */
    | 'cors-or-offline'
    /** HTTPS page cannot call plain-http non-localhost URL. */
    | 'mixed-content'
    | 'offline'
    | 'error';

export interface ProbeResult {
    status: ProbeStatus;
    /** Human-readable German detail for the UI. */
    detail: string;
    models?: string[];
    latencyMs?: number;
}

/** Which side a chat request will actually run on, after resolution. */
export interface RouteDecision {
    route: 'browser' | 'server';
    reason: string;
}
