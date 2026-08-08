import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchAgentCard, sendA2AMessage } from './client';

const realFetch = global.fetch;

afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
});

describe('fetchAgentCard', () => {
    it('discovers the card at /.well-known/agent-card.json', async () => {
        const card = {
            name: 'Research Agent',
            description: 'Recherchiert',
            url: 'https://agent.example/rpc',
            version: '1.0',
            skills: [{ id: 's1', name: 'Suche' }],
        };
        global.fetch = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url === 'https://agent.example/.well-known/agent-card.json') {
                return new Response(JSON.stringify(card), { status: 200 });
            }
            return new Response('not found', { status: 404 });
        }) as unknown as typeof fetch;

        const result = await fetchAgentCard('https://agent.example');
        expect(result.name).toBe('Research Agent');
        expect(result.url).toBe('https://agent.example/rpc');
        expect(result.cardUrl).toBe('https://agent.example/.well-known/agent-card.json');
        expect(result.skills?.[0].name).toBe('Suche');
    });

    it('falls back to the legacy agent.json path', async () => {
        global.fetch = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/.well-known/agent.json')) {
                return new Response(JSON.stringify({ name: 'Alt', url: 'https://alt.example/a2a' }), { status: 200 });
            }
            return new Response('nope', { status: 404 });
        }) as unknown as typeof fetch;

        const result = await fetchAgentCard('https://alt.example');
        expect(result.name).toBe('Alt');
    });
});

describe('sendA2AMessage', () => {
    it('returns the text of a direct message reply', async () => {
        global.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            expect(body.method).toBe('message/send');
            expect(body.params.message.parts[0].text).toBe('Hallo Agent');
            return new Response(JSON.stringify({
                jsonrpc: '2.0',
                id: body.id,
                result: { kind: 'message', role: 'agent', parts: [{ kind: 'text', text: 'Hallo zurück' }] },
            }), { status: 200 });
        }) as unknown as typeof fetch;

        const reply = await sendA2AMessage('https://agent.example/rpc', 'Hallo Agent');
        expect(reply).toBe('Hallo zurück');
    });

    it('extracts artifacts from completed tasks', async () => {
        global.fetch = vi.fn(async () => new Response(JSON.stringify({
            jsonrpc: '2.0',
            id: '1',
            result: {
                id: 'task-1',
                status: { state: 'completed' },
                artifacts: [{ parts: [{ kind: 'text', text: 'Analyse fertig' }] }],
            },
        }), { status: 200 })) as unknown as typeof fetch;

        const reply = await sendA2AMessage('https://agent.example/rpc', 'Analysiere');
        expect(reply).toBe('Analyse fertig');
    });
});
