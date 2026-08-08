import type { AdapterEvent, AdapterRequest, EngineMessage, EngineToolCall, ProtocolAdapter, ToolSpec } from '../types';
import { AdapterHttpError, NativeToolsUnsupportedError, iterateLines, postJson, sseData, syntheticCallId, withTimeoutSignal, LIST_TIMEOUT_MS } from './shared';

/**
 * OpenAI-compatible chat.completions adapter. Covers OpenAI itself and the
 * large compatible family (LM Studio, llama.cpp, vLLM, Groq, Mistral,
 * OpenRouter, Together, DeepSeek, xAI, Gemini-compat, custom gateways).
 */

interface WireMessage {
    role: string;
    content: string | null;
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    tool_call_id?: string;
}

function toWireMessages(messages: EngineMessage[]): WireMessage[] {
    return messages.map((m): WireMessage => {
        if (m.role === 'assistant' && m.toolCalls?.length) {
            return {
                role: 'assistant',
                content: m.content || null,
                tool_calls: m.toolCalls.map(tc => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: tc.args || '{}' },
                })),
            };
        }
        if (m.role === 'tool') {
            return { role: 'tool', content: m.content, tool_call_id: m.toolCallId || '' };
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

function authHeaders(apiKey?: string): Record<string, string> {
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** Accumulates streamed tool_call fragments (indexed deltas). */
class ToolCallAssembler {
    private byIndex = new Map<number, { id: string; name: string; args: string }>();

    feed(deltas: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>): void {
        for (const delta of deltas) {
            const index = delta.index ?? 0;
            const entry = this.byIndex.get(index) ?? { id: '', name: '', args: '' };
            if (delta.id) entry.id = delta.id;
            if (delta.function?.name) entry.name += delta.function.name;
            if (delta.function?.arguments) entry.args += delta.function.arguments;
            this.byIndex.set(index, entry);
        }
    }

    finish(): EngineToolCall[] {
        return [...this.byIndex.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, entry]) => ({
                id: entry.id || syntheticCallId('call'),
                name: entry.name,
                args: entry.args || '{}',
            }))
            .filter(call => call.name);
    }
}

function detectToolsUnsupported(error: unknown): boolean {
    if (!(error instanceof AdapterHttpError)) return false;
    if (error.status !== 400 && error.status !== 404 && error.status !== 422) return false;
    const body = (error.body || error.message).toLowerCase();
    return body.includes('tool') && (body.includes('support') || body.includes('unknown') || body.includes('invalid') || body.includes('unexpected'));
}

export const openaiAdapter: ProtocolAdapter = {
    protocol: 'openai',
    supportsNativeTools: true,

    async *streamChat(req: AdapterRequest): AsyncGenerator<AdapterEvent, void, unknown> {
        const url = `${req.baseUrl.replace(/\/+$/, '')}/chat/completions`;
        const body: Record<string, unknown> = {
            model: req.model,
            messages: toWireMessages(req.messages),
            stream: true,
        };
        if (req.tools?.length) body.tools = toWireTools(req.tools);
        if (req.options?.temperature !== undefined) body.temperature = req.options.temperature;
        if (req.options?.top_p !== undefined) body.top_p = req.options.top_p;
        if (req.options?.max_tokens !== undefined) body.max_tokens = req.options.max_tokens;

        let response: Response;
        try {
            response = await postJson(url, body, authHeaders(req.apiKey), req.signal);
        } catch (error) {
            if (req.tools?.length && detectToolsUnsupported(error)) {
                throw new NativeToolsUnsupportedError(error instanceof Error ? error.message : undefined);
            }
            throw error;
        }

        const assembler = new ToolCallAssembler();
        let model: string | undefined;

        for await (const line of iterateLines(response)) {
            const payload = sseData(line);
            if (!payload) continue;
            let chunk: {
                model?: string;
                choices?: Array<{
                    delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
                    finish_reason?: string | null;
                }>;
            };
            try {
                chunk = JSON.parse(payload);
            } catch {
                continue; // partial/foreign line
            }
            model = chunk.model || model;
            const choice = chunk.choices?.[0];
            if (!choice) continue;
            if (choice.delta?.content) yield { type: 'text', text: choice.delta.content };
            if (choice.delta?.tool_calls?.length) assembler.feed(choice.delta.tool_calls);
        }

        for (const call of assembler.finish()) {
            yield { type: 'toolCall', call };
        }
        yield { type: 'done', model };
    },

    async listModels(req): Promise<string[]> {
        const url = `${req.baseUrl.replace(/\/+$/, '')}/models`;
        const response = await fetch(url, {
            headers: authHeaders(req.apiKey),
            signal: withTimeoutSignal(req.signal, LIST_TIMEOUT_MS),
        });
        if (!response.ok) throw new AdapterHttpError(response.status, `HTTP ${response.status}`);
        const data = await response.json();
        const models: string[] = (data.data ?? [])
            .map((m: { id?: string }) => m.id)
            .filter((id: unknown): id is string => typeof id === 'string');
        return models.sort((a, b) => a.localeCompare(b));
    },
};
