'use client';

import type { UIResourceContent } from '@/components/a2ui/types';
import type { EngineMessage } from './types';
import { getAdapter, streamProviderChat } from './client';
import { runEngineTurn } from './engine';
import { buildSystemPrompt, type PromptContext } from './prompt';
import { toPromptInfo } from './tools.shared';
import { buildBrowserEngineDeps } from './browser/deps';
import { loadClientAIState, resolveBrowserProvider, resolveRoute, type ClientProviderRecord } from './store.client';
import { checkBackend } from '@/lib/platform/backend';

/**
 * The one entry point both chat surfaces use to run an assistant turn.
 *
 * Route resolution per selected provider decides who executes:
 * - 'server': POST /api/chat — the backend runs the engine (server keys,
 *   endpoints only it can reach)
 * - 'browser': the SAME engine runs here in the page — direct connection
 *   to local inference (Ollama/LM Studio/WebLLM) or CORS-enabled cloud
 *   APIs; works fully without a backend
 */

export interface TurnHandlers {
    /** Visible assistant text (already stripped of tool syntax). */
    onText(text: string): void;
    /** MCP-UI resource delivered by a tool — belongs on the stage. */
    onUiResource?(resource: UIResourceContent): void;
}

export interface AssistantTurnRequest {
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    context: PromptContext;
    provider?: ClientProviderRecord;
    model?: string;
    signal?: AbortSignal;
    handlers: TurnHandlers;
}

export interface AssistantTurnResult {
    text: string;
    route: 'server' | 'browser';
    uiResources: UIResourceContent[];
}

export async function runAssistantTurn(request: AssistantTurnRequest): Promise<AssistantTurnResult> {
    const { provider } = request;

    if (!provider) {
        // No explicit selection: server default when a backend exists,
        // otherwise the first browser-capable provider from local state.
        if ((await checkBackend()) === 'available') {
            return serverTurn(request, undefined);
        }
        const state = await loadClientAIState();
        const fallback = state.providers.find(p => p.enabled);
        if (!fallback) {
            throw new Error('Kein Inference-Provider konfiguriert. Öffne den AI-Hub (/ai) und richte einen ein.');
        }
        return browserTurn(request, fallback);
    }

    const route = await resolveRoute(provider);
    if (route.decision.route === 'server') {
        return serverTurn(request, provider);
    }
    return browserTurn(request, provider);
}

// ------------------------------------------------------------------
// Server path (NDJSON over POST /api/chat)
// ------------------------------------------------------------------

async function serverTurn(
    request: AssistantTurnRequest,
    provider: ClientProviderRecord | undefined
): Promise<AssistantTurnResult> {
    const uiResources: UIResourceContent[] = [];
    const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            messages: request.messages,
            context: request.context,
            stream: true,
            providerId: provider?.id,
            model: request.model,
        }),
        signal: request.signal,
    });

    if (!response.ok || !response.body) {
        let message = `Fehler: ${response.status}`;
        try {
            const err = await response.json();
            message = err.error || err.details || message;
        } catch { /* keep default */ }
        throw new Error(message);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let chunk: {
                message?: { content?: string };
                type?: string;
                resource?: UIResourceContent;
                error?: string;
            };
            try {
                chunk = JSON.parse(trimmed);
            } catch {
                continue;
            }
            if (chunk.error) throw new Error(chunk.error);
            if (chunk.type === 'ui-resource' && chunk.resource) {
                uiResources.push(chunk.resource);
                request.handlers.onUiResource?.(chunk.resource);
                continue;
            }
            if (chunk.message?.content) {
                text += chunk.message.content;
                request.handlers.onText(chunk.message.content);
            }
        }
    }

    return { text, route: 'server', uiResources };
}

// ------------------------------------------------------------------
// Browser path (engine in the page)
// ------------------------------------------------------------------

async function browserTurn(
    request: AssistantTurnRequest,
    provider: ClientProviderRecord
): Promise<AssistantTurnResult> {
    const state = await loadClientAIState();
    const deps = await buildBrowserEngineDeps(state);
    const resolved = resolveBrowserProvider(provider);
    const adapter = getAdapter(resolved.protocol);
    const nativeTools = provider.toolCalls !== 'text' && adapter.supportsNativeTools;

    const systemMessage: EngineMessage = {
        role: 'system',
        content: buildSystemPrompt({
            context: request.context,
            tools: deps.tools.map(toPromptInfo),
            agents: deps.agents,
            skills: deps.skills,
            nativeTools,
        }),
    };

    const history: EngineMessage[] = [
        systemMessage,
        ...request.messages.map(m => ({ role: m.role, content: m.content })),
    ];

    const uiResources: UIResourceContent[] = [];
    let text = '';
    let lastProgressBucket = -1;

    const result = await runEngineTurn(history, {
        stream: (messages, tools, signal) => streamProviderChat(resolved, {
            model: request.model,
            messages,
            tools,
            signal,
        }),
        tools: deps.tools,
        nativeTools,
        callAgent: deps.callAgent,
        signal: request.signal,
        onEvent: event => {
            switch (event.type) {
                case 'text':
                    text += event.text;
                    request.handlers.onText(event.text);
                    break;
                case 'status': {
                    const formatted = `\n\n> ${event.text}\n\n`;
                    text += formatted;
                    request.handlers.onText(formatted);
                    break;
                }
                case 'ui-resource':
                    uiResources.push(event.resource);
                    request.handlers.onUiResource?.(event.resource);
                    break;
                case 'progress': {
                    // Model load progress (WebLLM): report in 10% steps.
                    const bucket = event.value !== undefined ? Math.floor(event.value * 10) : -1;
                    if (bucket !== lastProgressBucket) {
                        lastProgressBucket = bucket;
                        const percent = event.value !== undefined ? ` ${Math.round(event.value * 100)}%` : '';
                        const formatted = `\n\n> Lade Modell…${percent}\n\n`;
                        request.handlers.onText(formatted);
                    }
                    break;
                }
            }
        },
    });

    return { text: text || result.finalText, route: 'browser', uiResources };
}
