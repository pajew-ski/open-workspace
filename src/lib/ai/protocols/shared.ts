/**
 * Shared plumbing for protocol adapters: line-based stream reading
 * (SSE "data:" and NDJSON), timeouts and typed HTTP errors.
 */

export class AdapterHttpError extends Error {
    constructor(
        public readonly status: number,
        message: string,
        public readonly body?: string
    ) {
        super(message);
        this.name = 'AdapterHttpError';
    }
}

/** Thrown when an endpoint rejects the native `tools` parameter — the engine falls back to text-syntax tool calls. */
export class NativeToolsUnsupportedError extends Error {
    constructor(message = 'Endpoint does not support native tool calling') {
        super(message);
        this.name = 'NativeToolsUnsupportedError';
    }
}

/** Time until response HEADERS must arrive; running streams are never cut. */
export const HEADER_TIMEOUT_MS = 120_000;
export const LIST_TIMEOUT_MS = 6_000;

/** Combine an optional caller signal with a timeout signal. */
export function withTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    if (!signal) return timeout;
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
    return signal; // very old runtimes: caller signal wins, no timeout
}

/**
 * POST JSON and fail with a typed error carrying the response body —
 * provider error bodies ("invalid api key", "model not found",
 * "does not support tools") are essential for diagnostics.
 */
export async function postJson(
    url: string,
    body: unknown,
    headers: Record<string, string>,
    signal?: AbortSignal
): Promise<Response> {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: withTimeoutSignal(signal, HEADER_TIMEOUT_MS),
    });
    if (!response.ok) {
        let text = '';
        try {
            text = await response.text();
        } catch {
            // body unreadable — status alone will have to do
        }
        throw new AdapterHttpError(response.status, `HTTP ${response.status}${text ? `: ${text.slice(0, 400)}` : ''}`, text);
    }
    return response;
}

/**
 * Iterate a streaming response line by line (SSE and NDJSON both are
 * newline-framed). Carries partial lines across chunk boundaries.
 */
export async function* iterateLines(response: Response): AsyncGenerator<string, void, unknown> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Response has no body stream');

    const decoder = new TextDecoder();
    let buffer = '';
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) yield line;
        }
        if (buffer.trim()) yield buffer;
    } finally {
        reader.releaseLock();
    }
}

/** Extract the JSON payload from an SSE "data: {...}" line; null for keep-alives/other fields. */
export function sseData(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return null;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return null;
    return payload;
}

let idCounter = 0;
/** Ids for tool calls from protocols that do not assign any (Ollama). */
export function syntheticCallId(prefix: string): string {
    idCounter += 1;
    return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}
