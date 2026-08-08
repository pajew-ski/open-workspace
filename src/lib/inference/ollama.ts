/**
 * Inference Client (server-side only)
 * Connects to Ollama or OpenAI-compatible endpoints (like Groq)
 *
 * Configuration resolution: explicit config argument > stored workspace
 * settings (data/settings.json) > environment > built-in defaults.
 * The API key is read from server-side env (LLM_API_KEY); the legacy
 * NEXT_PUBLIC_ names are still honored for backwards compatibility but
 * should not be used for secrets — NEXT_PUBLIC_ values get inlined into
 * the client bundle by Next.js.
 */

import { loadSettings } from '@/lib/settings';

export interface InferenceConfig {
    endpoint: string;
    model: string;
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface ChatOptions {
    temperature?: number;
    top_p?: number;
    num_predict?: number;
}

export interface ChatResponse {
    model: string;
    message: ChatMessage;
    done: boolean;
    total_duration?: number;
    eval_count?: number;
}

export interface StreamChunk {
    model: string;
    message: ChatMessage;
    done: boolean;
    choices?: { delta: { content: string } }[]; // OpenAI style
}

// Environment fallbacks (used when no stored settings exist)
const DEFAULT_CONFIG: InferenceConfig = {
    endpoint:
        process.env.LLM_API_BASE_URL ||
        process.env.NEXT_PUBLIC_LLM_API_BASE_URL ||
        'http://localhost:11434',
    model:
        process.env.LLM_MODEL ||
        process.env.NEXT_PUBLIC_LLM_MODEL ||
        'gpt-oss:20b',
};

// Server-side API key — never exposed to the client bundle
const API_KEY = process.env.LLM_API_KEY || process.env.NEXT_PUBLIC_LLM_API_KEY || '';

// How long we wait for the endpoint to accept the request / send headers
const REQUEST_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 5_000;

// Helper to determine API style
const isOpenAICompat = (endpoint: string) => endpoint.includes('/v1');

// Helper to normalize endpoint (remove trailing slash, remove /chat/completions)
const normalizeEndpoint = (url: string): string => {
    if (!url) return '';
    let clean = url.trim().replace(/\/+$/, ''); // Remove trailing slash
    // If user accidentally provided the full chat path, strip it
    if (clean.endsWith('/chat/completions')) {
        clean = clean.replace('/chat/completions', '');
    }
    return clean;
};

/**
 * Resolve the effective endpoint/model: explicit argument wins, then
 * stored workspace settings, then environment defaults.
 */
async function resolveConfig(config: Partial<InferenceConfig>): Promise<InferenceConfig> {
    if (config.endpoint && config.model) {
        return { endpoint: config.endpoint, model: config.model };
    }
    let stored: InferenceConfig = DEFAULT_CONFIG;
    try {
        const settings = await loadSettings();
        stored = settings.inference;
    } catch {
        // settings unavailable → env defaults
    }
    return {
        endpoint: config.endpoint || stored.endpoint || DEFAULT_CONFIG.endpoint,
        model: config.model || stored.model || DEFAULT_CONFIG.model,
    };
}

function authHeaders(): Record<string, string> {
    return API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {};
}

/**
 * fetch with a timeout that only covers the time until response headers
 * arrive — long-running streams are not cut off mid-generation.
 */
async function fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number
): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Send a chat request
 */
export async function chat(
    messages: ChatMessage[],
    config: Partial<InferenceConfig> = {},
    options?: ChatOptions
): Promise<ChatResponse> {
    const resolved = await resolveConfig(config);
    const endpoint = normalizeEndpoint(resolved.endpoint);
    const model = resolved.model;
    const isOpenAI = isOpenAICompat(endpoint);

    const url = isOpenAI
        ? `${endpoint}/chat/completions`
        : `${endpoint}/api/chat`;

    const body: Record<string, unknown> = {
        model,
        messages,
        stream: false,
    };

    if (isOpenAI) {
        if (options?.temperature !== undefined) body.temperature = options.temperature;
        if (options?.top_p !== undefined) body.top_p = options.top_p;
        if (options?.num_predict !== undefined) body.max_tokens = options.num_predict;
    } else if (options) {
        body.options = options;
    }

    const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
        },
        body: JSON.stringify(body),
    }, REQUEST_TIMEOUT_MS);

    if (!response.ok) {
        console.error('[Inference] Error:', response.status, response.statusText);
        throw new Error(`Inference API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (isOpenAI) {
        // Map OpenAI response to Ollama-like ChatResponse
        return {
            model: data.model,
            message: data.choices[0].message,
            done: true,
        };
    }

    return data;
}

/**
 * Send a streaming chat request
 */
export async function* chatStream(
    messages: ChatMessage[],
    config: Partial<InferenceConfig> = {},
    options?: ChatOptions
): AsyncGenerator<StreamChunk, void, unknown> {
    const resolved = await resolveConfig(config);
    const endpoint = normalizeEndpoint(resolved.endpoint);
    const model = resolved.model;
    const isOpenAI = isOpenAICompat(endpoint);

    const url = isOpenAI
        ? `${endpoint}/chat/completions`
        : `${endpoint}/api/chat`;

    const body: Record<string, unknown> = {
        model,
        messages,
        stream: true,
    };

    if (isOpenAI) {
        if (options?.temperature !== undefined) body.temperature = options.temperature;
        if (options?.top_p !== undefined) body.top_p = options.top_p;
        if (options?.num_predict !== undefined) body.max_tokens = options.num_predict;
    } else if (options) {
        body.options = options;
    }

    const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
        },
        body: JSON.stringify(body),
    }, REQUEST_TIMEOUT_MS);

    if (!response.ok) {
        console.error('[Inference] Stream Error:', response.status, response.statusText);
        throw new Error(`Inference API error: ${response.status} ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (trimmed === 'data: [DONE]') continue;

            try {
                // OpenAI often prefixes with "data: "
                const jsonStr = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed;
                const chunk = JSON.parse(jsonStr);

                if (isOpenAI) {
                    // Map OpenAI chunk to StreamChunk
                    if (chunk.choices && chunk.choices[0]?.delta?.content) {
                        yield {
                            model: chunk.model,
                            message: {
                                role: 'assistant',
                                content: chunk.choices[0].delta.content
                            },
                            done: false
                        };
                    }
                } else {
                    yield chunk; // Ollama chunk
                }
            } catch {
                // Skip invalid JSON
            }
        }
    }
}

/**
 * Check if Inference is available
 */
export async function checkHealth(
    config: Partial<InferenceConfig> = {}
): Promise<boolean> {
    const resolved = await resolveConfig(config);
    const endpoint = normalizeEndpoint(resolved.endpoint);
    const isOpenAI = isOpenAICompat(endpoint);

    try {
        const url = isOpenAI ? `${endpoint}/models` : `${endpoint}/api/tags`;
        const response = await fetchWithTimeout(url, {
            method: 'GET',
            headers: authHeaders(),
        }, HEALTH_TIMEOUT_MS);
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * Get available models
 */
export async function getModels(
    config: Partial<InferenceConfig> = {}
): Promise<string[]> {
    const resolved = await resolveConfig(config);
    const endpoint = normalizeEndpoint(resolved.endpoint);
    const isOpenAI = isOpenAICompat(endpoint);

    try {
        const url = isOpenAI ? `${endpoint}/models` : `${endpoint}/api/tags`;

        const response = await fetchWithTimeout(url, {
            method: 'GET',
            headers: authHeaders(),
        }, HEALTH_TIMEOUT_MS);

        if (!response.ok) return [];

        const data = await response.json();

        if (isOpenAI) {
            return data.data?.map((m: { id: string }) => m.id) || [];
        } else {
            return data.models?.map((m: { name: string }) => m.name) || [];
        }
    } catch {
        return [];
    }
}

/**
 * Resolve the currently effective inference configuration (for status UIs).
 */
export async function getEffectiveConfig(): Promise<InferenceConfig> {
    return resolveConfig({});
}

// Export specific interface for backward comp
export type OllamaConfig = InferenceConfig;
export { DEFAULT_CONFIG };
