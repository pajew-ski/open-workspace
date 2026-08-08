import type { AdapterEvent, AdapterRequest, EngineMessage, ProtocolAdapter, ToolSpec } from '../types';
import { AdapterHttpError, NativeToolsUnsupportedError, iterateLines, postJson, syntheticCallId, withTimeoutSignal, LIST_TIMEOUT_MS } from './shared';

/**
 * Ollama native API adapter (/api/chat NDJSON streaming, /api/tags model
 * list). Kept alongside the OpenAI adapter because the native API exposes
 * model management and options the compat layer hides.
 */

interface WireMessage {
    role: string;
    content: string;
    tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
}

function toWireMessages(messages: EngineMessage[]): WireMessage[] {
    return messages.map((m): WireMessage => {
        if (m.role === 'assistant' && m.toolCalls?.length) {
            return {
                role: 'assistant',
                content: m.content,
                tool_calls: m.toolCalls.map(tc => {
                    let args: unknown = {};
                    try {
                        args = tc.args ? JSON.parse(tc.args) : {};
                    } catch {
                        args = { _raw: tc.args };
                    }
                    return { function: { name: tc.name, arguments: args } };
                }),
            };
        }
        if (m.role === 'tool') {
            return { role: 'tool', content: m.content };
        }
        return { role: m.role, content: m.content };
    });
}

function toWireTools(tools: ToolSpec[]): unknown[] {
    return tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
}

function detectToolsUnsupported(error: unknown): boolean {
    if (!(error instanceof AdapterHttpError)) return false;
    const body = (error.body || error.message).toLowerCase();
    return body.includes('does not support tools') || (body.includes('tool') && body.includes('support'));
}

export const ollamaAdapter: ProtocolAdapter = {
    protocol: 'ollama',
    supportsNativeTools: true,

    async *streamChat(req: AdapterRequest): AsyncGenerator<AdapterEvent, void, unknown> {
        const url = `${req.baseUrl.replace(/\/+$/, '')}/api/chat`;
        const body: Record<string, unknown> = {
            model: req.model,
            messages: toWireMessages(req.messages),
            stream: true,
        };
        if (req.tools?.length) body.tools = toWireTools(req.tools);
        const options: Record<string, unknown> = {};
        if (req.options?.temperature !== undefined) options.temperature = req.options.temperature;
        if (req.options?.top_p !== undefined) options.top_p = req.options.top_p;
        if (req.options?.max_tokens !== undefined) options.num_predict = req.options.max_tokens;
        if (Object.keys(options).length > 0) body.options = options;

        let response: Response;
        try {
            response = await postJson(url, body, {}, req.signal);
        } catch (error) {
            if (req.tools?.length && detectToolsUnsupported(error)) {
                throw new NativeToolsUnsupportedError(error instanceof Error ? error.message : undefined);
            }
            throw error;
        }

        let model: string | undefined;
        for await (const line of iterateLines(response)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let chunk: {
                model?: string;
                message?: {
                    content?: string;
                    tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
                };
                error?: string;
            };
            try {
                chunk = JSON.parse(trimmed);
            } catch {
                continue;
            }
            if (chunk.error) throw new Error(chunk.error);
            model = chunk.model || model;
            if (chunk.message?.content) yield { type: 'text', text: chunk.message.content };
            for (const tc of chunk.message?.tool_calls ?? []) {
                if (!tc.function?.name) continue;
                yield {
                    type: 'toolCall',
                    call: {
                        id: syntheticCallId('ollama'),
                        name: tc.function.name,
                        args: JSON.stringify(tc.function.arguments ?? {}),
                    },
                };
            }
        }
        yield { type: 'done', model };
    },

    async listModels(req): Promise<string[]> {
        const url = `${req.baseUrl.replace(/\/+$/, '')}/api/tags`;
        const response = await fetch(url, {
            signal: withTimeoutSignal(req.signal, LIST_TIMEOUT_MS),
        });
        if (!response.ok) throw new AdapterHttpError(response.status, `HTTP ${response.status}`);
        const data = await response.json();
        return (data.models ?? [])
            .map((m: { name?: string }) => m.name)
            .filter((name: unknown): name is string => typeof name === 'string')
            .sort((a: string, b: string) => a.localeCompare(b));
    },
};
