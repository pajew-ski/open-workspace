import { NextRequest, NextResponse } from 'next/server';
import type { EngineMessage } from '@/lib/ai/types';
import { getAdapter, streamProviderChat } from '@/lib/ai/client';
import { resolveDefaultServerProvider, resolveServerProvider } from '@/lib/ai/store.server';
import { buildSystemPrompt } from '@/lib/ai/prompt';
import { runEngineTurn } from '@/lib/ai/engine';
import { buildServerEngineDeps } from '@/lib/ai/server/deps';
import { toPromptInfo } from '@/lib/ai/tools.shared';
import { checkChatRateLimit } from '@/lib/ai/server/chat-limits';
import { currentIdentity, getRequestGraph } from '@/lib/graph/server/context';
import { readSelfModel } from '@/lib/graph/meta/self-model-query';
import type { SelfModelView } from '@/lib/graph/meta/self-model-view';

/**
 * Server chat route on the isomorphic engine.
 *
 * This is ONE of two equivalent execution paths: the browser runs the
 * exact same engine locally when a provider's route resolves to
 * "browser" (local inference, browser-stored keys, serverless mode).
 * This route handles providers whose keys live on the server and
 * endpoints only the server can reach.
 *
 * Wire format (NDJSON, backward compatible):
 *   {message:{role:'assistant',content}, done:false}   visible text
 *   {type:'status', message:{…}}                       tool progress
 *   {type:'ui-resource', resource:{…}}                 MCP-UI resource for the stage
 *   {error, done:true}                                 terminal error
 */

export interface ChatRequestBody {
    messages: Array<{
        role: 'user' | 'assistant';
        content: string;
    }>;
    context: {
        module: string;
        moduleDescription: string;
        pathname: string;
        viewState?: Record<string, unknown>;
        /** Compact summary of the components currently on the generative surface */
        activeSurface?: Array<Record<string, unknown>>;
    };
    stream?: boolean;
    /** Provider/model override (from the chat model picker). */
    providerId?: string;
    model?: string;
}

/**
 * Selbstmodell der Instanz für den Prompt. Ein Fehler darf den Chat nicht
 * kosten: Ohne Modell sagt der Prompt nichts über das System, statt eine
 * veraltete Liste zu behaupten (Invariante 10).
 */
async function currentSelfModel(): Promise<SelfModelView | undefined> {
    try {
        const { store, iri, grant } = await getRequestGraph();
        return await readSelfModel(store, iri, { allowedGraphs: grant.readableGraphs });
    } catch (error) {
        console.error('Selbstmodell für den Prompt nicht ladbar:', error);
        return undefined;
    }
}

export async function POST(request: NextRequest) {
    try {
        // Zuerst das Limit, vor jeder Arbeit: Ein abgelehnter Turn darf
        // weder ein Modell noch den Store kosten (ANALYSE §5 P2.11).
        // „Ohne geprüfte Identität ist eine Anfrage anonym, nicht der
        // Einzelnutzer" (M12/M13) — gilt auch fürs Zählen: nur eine
        // authentifizierte Identität bekommt ihren eigenen Eimer.
        const identity = await currentIdentity().catch(() => null);
        const refusal = checkChatRateLimit(
            request,
            identity?.authenticated ? identity.userId : null,
        );
        if (refusal) {
            return NextResponse.json(
                { error: refusal.error },
                { status: 429, headers: { 'Retry-After': String(refusal.retryAfterSeconds) } },
            );
        }

        const body: ChatRequestBody = await request.json();
        const { messages, context, stream = false, providerId, model } = body;

        // Resolve the provider for the SERVER execution context.
        const resolution = providerId
            ? { resolved: await resolveServerProvider(providerId), model }
            : await (async () => {
                const def = await resolveDefaultServerProvider();
                return def ? { resolved: def.resolved, model: model ?? def.model } : { resolved: null, model };
            })();

        if (!resolution.resolved) {
            return NextResponse.json(
                { error: 'Kein Inference-Provider konfiguriert. Öffne den AI-Hub und richte einen Provider ein.' },
                { status: 503 }
            );
        }
        const resolved = resolution.resolved;
        if (resolved.protocol === 'webllm') {
            return NextResponse.json(
                { error: 'WebLLM läuft nur im Browser — dieser Chat muss die Browser-Route verwenden.' },
                { status: 400 }
            );
        }

        const deps = await buildServerEngineDeps(request.nextUrl.origin);
        const adapter = getAdapter(resolved.protocol);
        const nativeTools = resolved.provider.toolCalls !== 'text' && adapter.supportsNativeTools;

        // Systemkontext nach SPEC §18: Das Selbstmodell wird HIER aus dem
        // Graphen gelesen, nicht aus dem Anfrage-Körper übernommen — was
        // der Client mitschickt, ist Eingabe, keine Wahrheit über das
        // System (und was er sehen darf, klammert derselbe Grant).
        const systemMessage: EngineMessage = {
            role: 'system',
            content: buildSystemPrompt({
                context: { ...context, selfModel: await currentSelfModel() },
                tools: deps.tools.map(toPromptInfo),
                agents: deps.agents,
                skills: deps.skills,
                nativeTools,
            }),
        };

        const history: EngineMessage[] = [
            systemMessage,
            ...messages.map(m => ({ role: m.role, content: m.content })),
        ];

        const runOptions = {
            tools: deps.tools,
            nativeTools,
            callAgent: deps.callAgent,
        };

        if (stream) {
            const encoder = new TextEncoder();
            const readable = new ReadableStream({
                async start(controller) {
                    const emit = (payload: Record<string, unknown>) => {
                        controller.enqueue(encoder.encode(JSON.stringify(payload) + '\n'));
                    };
                    try {
                        await runEngineTurn(history, {
                            ...runOptions,
                            stream: (msgs, tools, signal) => streamProviderChat(resolved, {
                                model: resolution.model,
                                messages: msgs,
                                tools,
                                signal,
                            }),
                            signal: request.signal,
                            onEvent: event => {
                                switch (event.type) {
                                    case 'text':
                                        emit({ message: { role: 'assistant', content: event.text }, done: false });
                                        break;
                                    case 'status':
                                        emit({ type: 'status', message: { role: 'assistant', content: `\n\n> ${event.text}\n\n` }, done: false });
                                        break;
                                    case 'ui-resource':
                                        emit({ type: 'ui-resource', resource: event.resource, done: false });
                                        break;
                                    case 'progress':
                                        emit({ type: 'progress', label: event.label, value: event.value, done: false });
                                        break;
                                }
                            },
                        });
                        emit({ done: true });
                        controller.close();
                    } catch (error) {
                        const errorMessage = error instanceof Error ? error.message : 'Unknown stream error';
                        emit({ error: errorMessage, done: true });
                        controller.close();
                    }
                },
            });

            return new Response(readable, {
                headers: {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                },
            });
        }

        // Non-streaming: run the same engine, return the final text.
        let finalText = '';
        const result = await runEngineTurn(history, {
            ...runOptions,
            stream: (msgs, tools, signal) => streamProviderChat(resolved, {
                model: resolution.model,
                messages: msgs,
                tools,
                signal,
            }),
            onEvent: event => {
                if (event.type === 'text') finalText += event.text;
            },
        });
        return NextResponse.json({
            message: { role: 'assistant', content: finalText || result.finalText },
            done: true,
        });
    } catch (error) {
        console.error('Chat API error:', error);
        return NextResponse.json(
            {
                error: 'Verbindung zum AI-Server fehlgeschlagen. Prüfe deine Provider im AI-Hub.',
                details: error instanceof Error ? error.message : 'Unknown error'
            },
            { status: 500 }
        );
    }
}
