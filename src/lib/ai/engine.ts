import type { AdapterEvent, EngineMessage, EngineToolCall, ToolSpec } from './types';
import { CallMarkerStreamFilter } from '@/lib/tools/callParser';
import { NativeToolsUnsupportedError } from './protocols/shared';
import type { UIResourceContent } from '@/components/a2ui/types';

/**
 * The isomorphic conversation engine: one tool/agent loop that runs
 * identically on the server (/api/chat) and in the browser (serverless
 * mode / direct local inference).
 *
 * Per round it streams one model turn, collects tool calls — native
 * function calls when the provider supports them, [[TOOL:...]] text
 * markers as the universal fallback — executes them, feeds results back
 * and lets the model continue, up to `maxRounds`.
 */

export interface EngineToolResult {
    text: string;
    /** MCP-UI resources (ui:// URIs) delivered by the tool, rendered on the stage. */
    uiResources?: UIResourceContent[];
}

export interface EngineTool {
    name: string;
    description: string;
    /** JSON schema of the arguments (native calling + prompt docs). */
    parameters: Record<string, unknown>;
    source: 'builtin' | 'api' | 'mcp';
    execute(args: Record<string, unknown>): Promise<EngineToolResult>;
}

export type EngineEvent =
    | { type: 'text'; text: string }
    /** Markdown status note shown inline in the chat (tool progress etc.). */
    | { type: 'status'; text: string }
    | { type: 'progress'; label: string; value?: number }
    | { type: 'ui-resource'; resource: UIResourceContent }
    | { type: 'round'; round: number };

export interface EngineRunOptions {
    /** Stream one model turn. `tools` is undefined in text mode. */
    stream: (
        messages: EngineMessage[],
        tools: ToolSpec[] | undefined,
        signal?: AbortSignal
    ) => AsyncGenerator<AdapterEvent, void, unknown>;
    tools: EngineTool[];
    /** Attempt native function calling (falls back to text automatically). */
    nativeTools: boolean;
    callAgent?: (agentId: string, prompt: string) => Promise<string>;
    maxRounds?: number;
    signal?: AbortSignal;
    onEvent: (event: EngineEvent) => void;
}

export interface EngineRunResult {
    /** Visible assistant text of the whole turn (all rounds). */
    finalText: string;
    /** Full transcript including tool calls/results (for persistence/debug). */
    transcript: EngineMessage[];
    rounds: number;
}

const DEFAULT_MAX_ROUNDS = 4;
/** Tool output is truncated before being fed back to the model. */
const MAX_TOOL_RESULT_CHARS = 4000;

export function toToolSpecs(tools: EngineTool[]): ToolSpec[] {
    return tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

function truncateResult(text: string): string {
    return text.length > MAX_TOOL_RESULT_CHARS
        ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}… [gekürzt]`
        : text;
}

export async function runEngineTurn(history: EngineMessage[], options: EngineRunOptions): Promise<EngineRunResult> {
    const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
    const transcript: EngineMessage[] = [...history];
    const emit = options.onEvent;
    let finalText = '';
    let nativeActive = options.nativeTools && options.tools.length > 0;
    let round = 0;

    const findTool = (name: string) => options.tools.find(t => t.name === name);

    const executeToolCall = async (name: string, rawArgs: string): Promise<string> => {
        let args: Record<string, unknown> = {};
        if (rawArgs.trim()) {
            try {
                const parsed = JSON.parse(rawArgs);
                if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
            } catch {
                emit({ type: 'status', text: `Ungültige Argumente für \`${name}\`.` });
                return `Fehler: Argumente waren kein gültiges JSON: ${rawArgs.slice(0, 200)}`;
            }
        }

        const tool = findTool(name);
        if (!tool) {
            emit({ type: 'status', text: `Tool \`${name}\` nicht gefunden.` });
            return `Fehler: Tool "${name}" existiert nicht.`;
        }

        emit({ type: 'status', text: `Führe Tool **${name}** aus…` });
        try {
            const result = await tool.execute(args);
            for (const resource of result.uiResources ?? []) {
                emit({ type: 'ui-resource', resource });
            }
            return truncateResult(result.text);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
            emit({ type: 'status', text: `Tool **${name}** fehlgeschlagen: ${message}` });
            return `Fehler bei der Ausführung: ${message}`;
        }
    };

    const executeAgentCall = async (agentId: string, prompt: string): Promise<string> => {
        if (!options.callAgent) {
            return `Fehler: Agent-Delegation ist in diesem Modus nicht verfügbar.`;
        }
        emit({ type: 'status', text: `Delegiere an Agent **${agentId}**…` });
        try {
            const result = await options.callAgent(agentId, prompt);
            return truncateResult(result);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
            emit({ type: 'status', text: `Agent **${agentId}** fehlgeschlagen: ${message}` });
            return `Fehler bei der Delegation: ${message}`;
        }
    };

    while (round < maxRounds) {
        emit({ type: 'round', round });
        const filter = new CallMarkerStreamFilter(['TOOL', 'AGENT']);
        const nativeCalls: EngineToolCall[] = [];
        let roundText = '';

        try {
            const toolsParam = nativeActive ? toToolSpecs(options.tools) : undefined;
            for await (const event of options.stream(transcript, toolsParam, options.signal)) {
                if (event.type === 'text') {
                    roundText += event.text;
                    const visible = filter.feed(event.text);
                    if (visible) {
                        finalText += visible;
                        emit({ type: 'text', text: visible });
                    }
                } else if (event.type === 'toolCall') {
                    nativeCalls.push(event.call);
                } else if (event.type === 'progress') {
                    emit({ type: 'progress', label: event.label, value: event.value });
                }
            }
        } catch (error) {
            if (error instanceof NativeToolsUnsupportedError && nativeActive) {
                // Retry the same round without the tools parameter — the
                // text syntax in the system prompt takes over.
                nativeActive = false;
                emit({ type: 'status', text: 'Modell unterstützt kein natives Tool-Calling — nutze Text-Syntax.' });
                continue;
            }
            throw error;
        }

        const tail = filter.flush();
        if (tail) {
            finalText += tail;
            emit({ type: 'text', text: tail });
        }

        const textCalls = filter.calls;
        if (nativeCalls.length === 0 && textCalls.length === 0) break;

        // Record the assistant turn (raw text incl. marker syntax + native calls).
        transcript.push({
            role: 'assistant',
            content: roundText,
            toolCalls: nativeCalls.length > 0 ? nativeCalls : undefined,
        });

        const isLastRound = round === maxRounds - 1;
        const limitNote = isLastRound
            ? '\n(Hinweis: Tool-Limit erreicht — fasse jetzt zusammen, ohne weitere Tools aufzurufen.)'
            : '';

        for (const call of nativeCalls) {
            const result = await executeToolCall(call.name, call.args);
            transcript.push({
                role: 'tool',
                content: result + limitNote,
                toolCallId: call.id,
                toolName: call.name,
            });
        }

        for (const call of textCalls) {
            if (call.kind === 'AGENT') {
                const result = await executeAgentCall(call.id, call.payload);
                transcript.push({
                    role: 'user',
                    content: `[AGENT_RESULT ${call.id}]: ${result}` +
                        (isLastRound ? limitNote : '\nFasse das Ergebnis für den Nutzer verständlich zusammen.'),
                });
            } else {
                const result = await executeToolCall(call.id, call.payload);
                transcript.push({
                    role: 'user',
                    content: `[TOOL_RESULT ${call.id}]: ${result}` +
                        (isLastRound ? limitNote : '\nFasse das Ergebnis für den Nutzer verständlich zusammen.'),
                });
            }
        }

        round += 1;
    }

    return { finalText, transcript, rounds: round };
}
