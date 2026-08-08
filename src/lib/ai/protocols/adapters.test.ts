import { describe, it, expect, vi, afterEach } from 'vitest';
import { openaiAdapter } from './openai';
import { anthropicAdapter } from './anthropic';
import { ollamaAdapter } from './ollama';
import type { AdapterEvent, EngineMessage } from '../types';

/**
 * Protocol adapter tests against mocked wire responses: request shaping
 * (message/tool mapping per protocol) and stream parsing (text deltas,
 * native tool calls across chunk fragments).
 */

const realFetch = global.fetch;

afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
});

interface RecordedRequest {
    url: string;
    init?: RequestInit;
}

/** Replace global fetch and record every request for assertions. */
function mockFetchResponse(body: string, init: ResponseInit = { status: 200 }): RecordedRequest[] {
    const requests: RecordedRequest[] = [];
    global.fetch = (async (input: RequestInfo | URL, requestInit?: RequestInit) => {
        requests.push({ url: String(input), init: requestInit });
        return new Response(body, init);
    }) as typeof fetch;
    return requests;
}

async function collect(gen: AsyncGenerator<AdapterEvent, void, unknown>): Promise<AdapterEvent[]> {
    const events: AdapterEvent[] = [];
    for await (const event of gen) events.push(event);
    return events;
}

const MESSAGES: EngineMessage[] = [
    { role: 'system', content: 'Systemprompt' },
    { role: 'user', content: 'Hallo' },
];

describe('openaiAdapter', () => {
    it('streams text deltas and assembles fragmented tool calls', async () => {
        const sse = [
            'data: {"model":"gpt-test","choices":[{"delta":{"content":"Hal"}}]}',
            'data: {"choices":[{"delta":{"content":"lo!"}}]}',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"web_","arguments":"{\\"q\\":"}}]}}]}',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"search","arguments":"\\"berlin\\"}"}}]}}]}',
            'data: [DONE]',
            '',
        ].join('\n\n');
        const requests = mockFetchResponse(sse);

        const events = await collect(openaiAdapter.streamChat({
            baseUrl: 'https://api.example/v1',
            apiKey: 'sk-test',
            model: 'gpt-test',
            messages: MESSAGES,
            tools: [{ name: 'web_search', description: 'Suche', parameters: { type: 'object' } }],
        }));

        const text = events.filter(e => e.type === 'text').map(e => (e as { text: string }).text).join('');
        expect(text).toBe('Hallo!');

        const call = events.find(e => e.type === 'toolCall') as Extract<AdapterEvent, { type: 'toolCall' }>;
        expect(call.call.id).toBe('call_1');
        expect(call.call.name).toBe('web_search');
        expect(JSON.parse(call.call.args)).toEqual({ q: 'berlin' });

        // Request shaping: auth header + tools wire format
        const { url, init } = requests[0];
        expect(url).toBe('https://api.example/v1/chat/completions');
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
        const body = JSON.parse(init?.body as string);
        expect(body.tools[0]).toEqual({
            type: 'function',
            function: { name: 'web_search', description: 'Suche', parameters: { type: 'object' } },
        });
    });

    it('maps assistant tool calls and tool results to the wire format', async () => {
        const requests = mockFetchResponse('data: [DONE]\n');
        await collect(openaiAdapter.streamChat({
            baseUrl: 'https://api.example/v1',
            model: 'gpt-test',
            messages: [
                { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'lookup', args: '{"x":1}' }] },
                { role: 'tool', content: 'Ergebnis', toolCallId: 'c1', toolName: 'lookup' },
            ],
        }));
        const body = JSON.parse(requests[0].init?.body as string);
        expect(body.messages[0].tool_calls[0]).toEqual({
            id: 'c1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"x":1}' },
        });
        expect(body.messages[1]).toEqual({ role: 'tool', content: 'Ergebnis', tool_call_id: 'c1' });
    });
});

describe('anthropicAdapter', () => {
    it('hoists system prompts, merges tool results, parses tool_use streams', async () => {
        const sse = [
            'data: {"type":"message_start","message":{"model":"claude-test"}}',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Ich suche."}}',
            'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_1","name":"web_search"}}',
            'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"b"}}',
            'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"erlin\\"}"}}',
            'data: {"type":"content_block_stop"}',
            'data: {"type":"message_stop"}',
            '',
        ].join('\n\n');
        const requests = mockFetchResponse(sse);

        const events = await collect(anthropicAdapter.streamChat({
            baseUrl: 'https://api.anthropic.com',
            apiKey: 'sk-ant',
            model: 'claude-test',
            inBrowser: true,
            messages: [
                { role: 'system', content: 'Systemprompt' },
                { role: 'user', content: 'Hallo' },
                { role: 'assistant', content: 'Moment.', toolCalls: [{ id: 'toolu_0', name: 'lookup', args: '{}' }] },
                { role: 'tool', content: 'A', toolCallId: 'toolu_0' },
                { role: 'tool', content: 'B', toolCallId: 'toolu_0b' },
            ],
        }));

        const text = events.filter(e => e.type === 'text').map(e => (e as { text: string }).text).join('');
        expect(text).toBe('Ich suche.');
        const call = events.find(e => e.type === 'toolCall') as Extract<AdapterEvent, { type: 'toolCall' }>;
        expect(call.call).toEqual({ id: 'toolu_1', name: 'web_search', args: '{"q":"berlin"}' });

        const { url, init } = requests[0];
        expect(url).toBe('https://api.anthropic.com/v1/messages');
        const headers = init?.headers as Record<string, string>;
        expect(headers['x-api-key']).toBe('sk-ant');
        expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');

        const body = JSON.parse(init?.body as string);
        expect(body.system).toBe('Systemprompt');
        // Both consecutive tool results merged into ONE user message
        const toolResultMessage = body.messages.find(
            (m: { role: string; content: Array<{ type: string }> }) =>
                m.role === 'user' && m.content[0]?.type === 'tool_result'
        );
        expect(toolResultMessage.content).toHaveLength(2);
    });
});

describe('ollamaAdapter', () => {
    it('parses NDJSON streams with tool calls (object arguments)', async () => {
        const ndjson = [
            '{"model":"qwen3","message":{"content":"Ich "}}',
            '{"message":{"content":"prüfe."}}',
            '{"message":{"content":"","tool_calls":[{"function":{"name":"weather","arguments":{"lat":52.5}}}]}}',
            '{"done":true}',
            '',
        ].join('\n');
        mockFetchResponse(ndjson);

        const events = await collect(ollamaAdapter.streamChat({
            baseUrl: 'http://localhost:11434',
            model: 'qwen3',
            messages: MESSAGES,
        }));

        const text = events.filter(e => e.type === 'text').map(e => (e as { text: string }).text).join('');
        expect(text).toBe('Ich prüfe.');
        const call = events.find(e => e.type === 'toolCall') as Extract<AdapterEvent, { type: 'toolCall' }>;
        expect(call.call.name).toBe('weather');
        expect(JSON.parse(call.call.args)).toEqual({ lat: 52.5 });
    });

    it('lists models from /api/tags', async () => {
        mockFetchResponse(JSON.stringify({ models: [{ name: 'b-model' }, { name: 'a-model' }] }));
        const models = await ollamaAdapter.listModels({ baseUrl: 'http://localhost:11434' });
        expect(models).toEqual(['a-model', 'b-model']);
    });
});
