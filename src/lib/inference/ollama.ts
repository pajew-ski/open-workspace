/**
 * Ollama API Client
 * Connects to local Ollama instance for AI inference
 */

export interface OllamaConfig {
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
}

// Default configuration
const DEFAULT_CONFIG: OllamaConfig = {
    endpoint: process.env.NEXT_PUBLIC_INFERENCE_ENDPOINT || 'http://192.168.42.2:11434',
    model: process.env.NEXT_PUBLIC_INFERENCE_MODEL || 'gpt-oss:20b',
};

/**
 * Send a chat request to Ollama
 */
export async function chat(
    messages: ChatMessage[],
    config: Partial<OllamaConfig> = {}
): Promise<ChatResponse> {
    const { endpoint, model } = { ...DEFAULT_CONFIG, ...config };

    const response = await fetch(`${endpoint}/api/chat`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            messages,
            stream: false,
        } as ChatRequest),
    });

    if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
}

/**
 * Send a streaming chat request to Ollama
 * Returns an async generator that yields message chunks
 */
export async function* chatStream(
    messages: ChatMessage[],
    config: Partial<OllamaConfig> = {}
): AsyncGenerator<StreamChunk, void, unknown> {
    const { endpoint, model } = { ...DEFAULT_CONFIG, ...config };

    const response = await fetch(`${endpoint}/api/chat`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            messages,
            stream: true,
        } as ChatRequest),
    });

    if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
        throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (line.trim()) {
                try {
                    const chunk: StreamChunk = JSON.parse(line);
                    yield chunk;
                } catch {
                    // Skip invalid JSON lines
                }
            }
        }
    }
}

/**
 * Check if Ollama is available
 */
export async function checkHealth(
    config: Partial<OllamaConfig> = {}
): Promise<boolean> {
    const { endpoint } = { ...DEFAULT_CONFIG, ...config };

    try {
        const response = await fetch(`${endpoint}/api/tags`, {
            method: 'GET',
        });
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * Get available models from Ollama
 */
export async function getModels(
    config: Partial<OllamaConfig> = {}
): Promise<string[]> {
    const { endpoint } = { ...DEFAULT_CONFIG, ...config };

    const response = await fetch(`${endpoint}/api/tags`, {
        method: 'GET',
    });

    if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status}`);
    }

    const data = await response.json();
    return data.models?.map((m: { name: string }) => m.name) || [];
}

export { DEFAULT_CONFIG };
