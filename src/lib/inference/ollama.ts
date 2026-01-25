/**
 * Inference Client
 * Connects to Ollama or OpenAI-compatible endpoints (like Groq)
 */

export interface InferenceConfig {
    endpoint: string;
    model: string;
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface ChatRequest {
    model: string;
    messages: ChatMessage[];
    stream?: boolean;
    options?: {
        temperature?: number;
        top_p?: number;
        num_predict?: number;
    };
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

// Default configuration
const DEFAULT_CONFIG: InferenceConfig = {
    endpoint: process.env.NEXT_PUBLIC_LLM_API_BASE_URL || 'http://localhost:11434',
    model: process.env.NEXT_PUBLIC_LLM_MODEL || 'gpt-oss:20b',
};

// Optional API Key
const API_KEY = process.env.NEXT_PUBLIC_LLM_API_KEY || '';

// Helper to determine API style
const isOpenCWCompat = (endpoint: string) => endpoint.includes('/v1');

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
 * Send a chat request
 */
export async function chat(
    messages: ChatMessage[],
    config: Partial<InferenceConfig> = {}
): Promise<ChatResponse> {
    const rawEndpoint = config.endpoint || DEFAULT_CONFIG.endpoint;
    const endpoint = normalizeEndpoint(rawEndpoint);
    const model = config.model || DEFAULT_CONFIG.model;
    const isOpenAI = isOpenCWCompat(endpoint);

    // Construct URL
    const url = isOpenAI
        ? `${endpoint}/chat/completions`
        : `${endpoint}/api/chat`;

    console.log('[Inference] Chat Request:', {
        originalEndpoint: rawEndpoint,
        usedEndpoint: endpoint,
        url,
        model,
        mode: isOpenAI ? 'OpenAI/Groq' : 'Ollama'
    });

    // Construct Body
    const body: any = {
        model,
        messages,
        stream: false,
    };

    if (!isOpenAI) {
        // Ollama specific options if needed
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(API_KEY ? { 'Authorization': `Bearer ${API_KEY}` } : {}),
        },
        body: JSON.stringify(body),
    });

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
    config: Partial<InferenceConfig> = {}
): AsyncGenerator<StreamChunk, void, unknown> {
    const rawEndpoint = config.endpoint || DEFAULT_CONFIG.endpoint;
    const endpoint = normalizeEndpoint(rawEndpoint);
    const model = config.model || DEFAULT_CONFIG.model;
    const isOpenAI = isOpenCWCompat(endpoint);

    const url = isOpenAI
        ? `${endpoint}/chat/completions`
        : `${endpoint}/api/chat`;

    console.log('[Inference] Stream Request:', {
        url,
        model,
        mode: isOpenAI ? 'OpenAI/Groq' : 'Ollama'
    });

    const body: any = {
        model,
        messages,
        stream: true,
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(API_KEY ? { 'Authorization': `Bearer ${API_KEY}` } : {}),
        },
        body: JSON.stringify(body),
    });

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
    const rawEndpoint = config.endpoint || DEFAULT_CONFIG.endpoint;
    const endpoint = normalizeEndpoint(rawEndpoint);
    const isOpenAI = isOpenCWCompat(endpoint);

    try {
        if (isOpenAI) {
            // Try OpenAI-compatible health check (listing models)
            const response = await fetch(`${endpoint}/models`, {
                method: 'GET',
                headers: {
                    ...(API_KEY ? { 'Authorization': `Bearer ${API_KEY}` } : {}),
                }
            });
            return response.ok;
        } else {
            // Ollama health check
            const response = await fetch(`${endpoint}/api/tags`, {
                method: 'GET',
            });
            return response.ok;
        }
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
    const rawEndpoint = config.endpoint || DEFAULT_CONFIG.endpoint;
    const endpoint = normalizeEndpoint(rawEndpoint);
    const isOpenAI = isOpenCWCompat(endpoint);

    try {
        const url = isOpenAI ? `${endpoint}/models` : `${endpoint}/api/tags`;
        console.log('[Inference] Fetch Models:', url);

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                ...(API_KEY ? { 'Authorization': `Bearer ${API_KEY}` } : {}),
            }
        });

        if (!response.ok) return [];

        const data = await response.json();

        if (isOpenAI) {
            return data.data?.map((m: any) => m.id) || [];
        } else {
            return data.models?.map((m: { name: string }) => m.name) || [];
        }
    } catch {
        return [];
    }
}

// Export specific interface for backward comp
export type OllamaConfig = InferenceConfig;
export { DEFAULT_CONFIG };
