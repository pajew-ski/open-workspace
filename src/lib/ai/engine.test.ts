import { describe, it, expect, vi } from 'vitest';
import { runEngineTurn, type EngineTool } from './engine';
import { NativeToolsUnsupportedError } from './protocols/shared';
import type { AdapterEvent, EngineMessage, ToolSpec } from './types';

/**
 * Engine tests with scripted fake streams: text-syntax tool loop,
 * native tool-call loop, native→text fallback, agent delegation and
 * the round cap.
 */

function textStream(...chunks: string[]): AsyncGenerator<AdapterEvent, void, unknown> {
    return (async function* () {
        for (const chunk of chunks) yield { type: 'text', text: chunk } as AdapterEvent;
        yield { type: 'done' } as AdapterEvent;
    })();
}

function makeTool(name: string, result: string): EngineTool & { calls: Array<Record<string, unknown>> } {
    const calls: Array<Record<string, unknown>> = [];
    return {
        name,
        description: `Tool ${name}`,
        parameters: { type: 'object' },
        source: 'api',
        calls,
        async execute(args) {
            calls.push(args);
            return { text: result };
        },
    };
}

const HISTORY: EngineMessage[] = [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'Frage' },
];

describe('runEngineTurn — text syntax', () => {
    it('hides tool markers, executes tools, feeds results back, continues', async () => {
        const tool = makeTool('weather', '{"temp":21}');
        const streams = [
            textStream('Ich prüfe das Wetter. [[TOOL:weather:', '{"lat":52.5}]]'),
            textStream('Es sind 21 Grad.'),
        ];
        let round = 0;
        const seenHistories: EngineMessage[][] = [];

        const events: string[] = [];
        const result = await runEngineTurn(HISTORY, {
            stream: messages => {
                seenHistories.push([...messages]);
                return streams[round++];
            },
            tools: [tool],
            nativeTools: false,
            onEvent: e => {
                if (e.type === 'text') events.push(e.text);
            },
        });

        expect(result.finalText).toBe('Ich prüfe das Wetter. Es sind 21 Grad.');
        expect(tool.calls).toEqual([{ lat: 52.5 }]);
        // Round 2 history contains the raw assistant turn + tool result as user turn
        const second = seenHistories[1];
        expect(second[second.length - 2].role).toBe('assistant');
        expect(second[second.length - 1].role).toBe('user');
        expect(second[second.length - 1].content).toContain('[TOOL_RESULT weather]');
        expect(second[second.length - 1].content).toContain('{"temp":21}');
    });

    it('delegates [[AGENT:...]] calls and feeds the result back', async () => {
        const callAgent = vi.fn(async () => 'Bericht des Agenten');
        const streams = [
            textStream('Ich frage den Agenten. [[AGENT:research:Analysiere X]]'),
            textStream('Fertig.'),
        ];
        let round = 0;

        const result = await runEngineTurn(HISTORY, {
            stream: () => streams[round++],
            tools: [],
            nativeTools: false,
            callAgent,
            onEvent: () => undefined,
        });

        expect(callAgent).toHaveBeenCalledWith('research', 'Analysiere X');
        expect(result.finalText).toBe('Ich frage den Agenten. Fertig.');
        const agentResult = result.transcript.find(m => m.content.startsWith('[AGENT_RESULT research]'));
        expect(agentResult?.content).toContain('Bericht des Agenten');
    });

    it('stops at the round cap', async () => {
        const tool = makeTool('loop', 'weiter');
        let rounds = 0;
        const result = await runEngineTurn(HISTORY, {
            stream: () => {
                rounds += 1;
                return textStream(`Runde ${rounds}. [[TOOL:loop:{}]]`);
            },
            tools: [tool],
            nativeTools: false,
            maxRounds: 2,
            onEvent: () => undefined,
        });
        expect(rounds).toBe(2);
        expect(result.rounds).toBe(2);
        expect(tool.calls).toHaveLength(2);
    });
});

describe('runEngineTurn — native tool calling', () => {
    it('executes native tool calls and records tool-role results', async () => {
        const tool = makeTool('lookup', 'Datenbank-Antwort');
        const streams: Array<AsyncGenerator<AdapterEvent, void, unknown>> = [
            (async function* () {
                yield { type: 'text', text: 'Moment…' } as AdapterEvent;
                yield { type: 'toolCall', call: { id: 'c1', name: 'lookup', args: '{"id":7}' } } as AdapterEvent;
                yield { type: 'done' } as AdapterEvent;
            })(),
            textStream('Gefunden.'),
        ];
        let round = 0;
        const toolParams: Array<ToolSpec[] | undefined> = [];

        const result = await runEngineTurn(HISTORY, {
            stream: (_messages, tools) => {
                toolParams.push(tools);
                return streams[round++];
            },
            tools: [tool],
            nativeTools: true,
            onEvent: () => undefined,
        });

        expect(toolParams[0]?.[0].name).toBe('lookup');
        expect(tool.calls).toEqual([{ id: 7 }]);
        const toolMessage = result.transcript.find(m => m.role === 'tool');
        expect(toolMessage).toMatchObject({ toolCallId: 'c1', toolName: 'lookup' });
        expect(result.finalText).toBe('Moment…Gefunden.');
    });

    it('falls back to text syntax when the endpoint rejects native tools', async () => {
        const tool = makeTool('weather', 'sonnig');
        let attempts = 0;
        const statuses: string[] = [];

        const result = await runEngineTurn(HISTORY, {
            stream: (_messages, tools) => {
                attempts += 1;
                if (tools) {
                    // First attempt with native tools → endpoint refuses
                    return (async function* (): AsyncGenerator<AdapterEvent, void, unknown> {
                        throw new NativeToolsUnsupportedError();
                    })();
                }
                return textStream('Antwort ohne native Tools.');
            },
            tools: [tool],
            nativeTools: true,
            onEvent: e => {
                if (e.type === 'status') statuses.push(e.text);
            },
        });

        expect(attempts).toBe(2);
        expect(result.finalText).toBe('Antwort ohne native Tools.');
        expect(statuses.some(s => s.includes('Text-Syntax'))).toBe(true);
    });

    it('surfaces MCP ui:// resources as ui-resource events', async () => {
        const uiTool: EngineTool = {
            name: 'dashboard',
            description: 'liefert UI',
            parameters: { type: 'object' },
            source: 'mcp',
            async execute() {
                return {
                    text: 'UI geliefert',
                    uiResources: [{ uri: 'ui://demo/1', mimeType: 'text/html', text: '<p>Hi</p>' }],
                };
            },
        };
        const streams = [
            textStream('[[TOOL:dashboard:{}]]'),
            textStream('Hier ist dein Dashboard.'),
        ];
        let round = 0;
        const resources: unknown[] = [];

        await runEngineTurn(HISTORY, {
            stream: () => streams[round++],
            tools: [uiTool],
            nativeTools: false,
            onEvent: e => {
                if (e.type === 'ui-resource') resources.push(e.resource);
            },
        });

        expect(resources).toEqual([{ uri: 'ui://demo/1', mimeType: 'text/html', text: '<p>Hi</p>' }]);
    });
});
