import type { AdapterEvent, AdapterRequest, EngineMessage, ProtocolAdapter, ToolSpec } from '../types';
import { AdapterHttpError, iterateLines, postJson, sseData, syntheticCallId, withTimeoutSignal, LIST_TIMEOUT_MS } from './shared';

/**
 * Anthropic Messages API adapter (Claude).
 *
 * Browser-direct access is officially supported via the
 * `anthropic-dangerous-direct-browser-access` header — the workspace uses
 * it only for keys the user explicitly stored browser-side.
 */

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

type ContentBlock =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'tool_result'; tool_use_id: string; content: string };

interface WireMessage {
    role: 'user' | 'assistant';
    content: ContentBlock[];
}

/**
 * Map engine messages to Anthropic wire format:
 * - system messages are hoisted into the `system` parameter
 * - tool results become tool_result blocks in a user message; consecutive
 *   results merge into one message (required ordering after tool_use)
 */
function toWire(messages: EngineMessage[]): { system: string; messages: WireMessage[] } {
    const systemParts: string[] = [];
    const wire: WireMessage[] = [];

    for (const m of messages) {
        if (m.role === 'system') {
            systemParts.push(m.content);
            continue;
        }
        if (m.role === 'tool') {
            const block: ContentBlock = {
                type: 'tool_result',
                tool_use_id: m.toolCallId || '',
                content: m.content,
            };
            const last = wire[wire.length - 1];
            if (last && last.role === 'user' && last.content.every(b => b.type === 'tool_result')) {
                last.content.push(block);
            } else {
                wire.push({ role: 'user', content: [block] });
            }
            continue;
        }
        if (m.role === 'assistant') {
            const blocks: ContentBlock[] = [];
            if (m.content) blocks.push({ type: 'text', text: m.content });
            for (const call of m.toolCalls ?? []) {
                let input: unknown = {};
                try {
                    input = call.args ? JSON.parse(call.args) : {};
                } catch {
                    input = { _raw: call.args };
                }
                blocks.push({ type: 'tool_use', id: call.id, name: call.name, input });
            }
            if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
            wire.push({ role: 'assistant', content: blocks });
            continue;
        }
        wire.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
    }

    return { system: systemParts.join('\n\n'), messages: wire };
}

function headers(apiKey: string | undefined, inBrowser: boolean | undefined): Record<string, string> {
    const h: Record<string, string> = {
        'anthropic-version': ANTHROPIC_VERSION,
    };
    if (apiKey) h['x-api-key'] = apiKey;
    if (inBrowser) h['anthropic-dangerous-direct-browser-access'] = 'true';
    return h;
}

function toWireTools(tools: ToolSpec[]): unknown[] {
    return tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

export const anthropicAdapter: ProtocolAdapter = {
    protocol: 'anthropic',
    supportsNativeTools: true,

    async *streamChat(req: AdapterRequest): AsyncGenerator<AdapterEvent, void, unknown> {
        const url = `${req.baseUrl.replace(/\/+$/, '')}/v1/messages`;
        const { system, messages } = toWire(req.messages);

        const body: Record<string, unknown> = {
            model: req.model,
            messages,
            max_tokens: req.options?.max_tokens ?? DEFAULT_MAX_TOKENS,
            stream: true,
        };
        if (system) body.system = system;
        if (req.tools?.length) body.tools = toWireTools(req.tools);
        if (req.options?.temperature !== undefined) body.temperature = req.options.temperature;
        if (req.options?.top_p !== undefined) body.top_p = req.options.top_p;

        const response = await postJson(url, body, headers(req.apiKey, req.inBrowser), req.signal);

        // Streaming state: the currently open tool_use block, if any.
        let openTool: { id: string; name: string; json: string } | null = null;
        let model: string | undefined;

        for await (const line of iterateLines(response)) {
            const payload = sseData(line);
            if (!payload) continue;
            let event: {
                type?: string;
                message?: { model?: string };
                content_block?: { type?: string; id?: string; name?: string };
                delta?: { type?: string; text?: string; partial_json?: string };
                error?: { message?: string };
            };
            try {
                event = JSON.parse(payload);
            } catch {
                continue;
            }

            switch (event.type) {
                case 'message_start':
                    model = event.message?.model || model;
                    break;
                case 'content_block_start':
                    if (event.content_block?.type === 'tool_use') {
                        openTool = {
                            id: event.content_block.id || syntheticCallId('toolu'),
                            name: event.content_block.name || '',
                            json: '',
                        };
                    }
                    break;
                case 'content_block_delta':
                    if (event.delta?.type === 'text_delta' && event.delta.text) {
                        yield { type: 'text', text: event.delta.text };
                    } else if (event.delta?.type === 'input_json_delta' && openTool) {
                        openTool.json += event.delta.partial_json || '';
                    }
                    break;
                case 'content_block_stop':
                    if (openTool) {
                        yield {
                            type: 'toolCall',
                            call: { id: openTool.id, name: openTool.name, args: openTool.json || '{}' },
                        };
                        openTool = null;
                    }
                    break;
                case 'error':
                    throw new Error(event.error?.message || 'Anthropic stream error');
            }
        }
        yield { type: 'done', model };
    },

    async listModels(req): Promise<string[]> {
        const url = `${req.baseUrl.replace(/\/+$/, '')}/v1/models?limit=100`;
        const response = await fetch(url, {
            headers: headers(req.apiKey, req.inBrowser),
            signal: withTimeoutSignal(req.signal, LIST_TIMEOUT_MS),
        });
        if (!response.ok) throw new AdapterHttpError(response.status, `HTTP ${response.status}`);
        const data = await response.json();
        return (data.data ?? [])
            .map((m: { id?: string }) => m.id)
            .filter((id: unknown): id is string => typeof id === 'string');
    },
};
