import { NextRequest, NextResponse } from 'next/server';
import { chat, chatStream, ChatMessage } from '@/lib/inference';
import { executeTool } from '@/lib/tools/executor';
import { ToolCallStreamFilter } from '@/lib/tools/callParser';

export interface ChatRequestBody {
    messages: Array<{
        role: 'user' | 'assistant';
        content: string;
    }>;
    context: {
        module: string;
        moduleDescription: string;
        pathname: string;
        viewState?: Record<string, any>;
    };
    stream?: boolean;
}

import { loadTools } from '@/lib/tools/storage';
import { Tool } from '@/lib/tools/types';

/**
 * Build system prompt with context awareness and tools
 */
async function buildSystemPrompt(context: ChatRequestBody['context']): Promise<string> {
    let viewStateContext = '';
    if (context.viewState && Object.keys(context.viewState).length > 0) {
        viewStateContext = `\nAKTUELLE ANSICHT (Was der Nutzer sieht):\n${JSON.stringify(context.viewState, null, 2)}`;
    }

    // Load available tools (built-in finder + user-configured API tools)
    const tools = await loadTools();
    const toolLines = [
        `- Workspace-Suche (ID: workspace_finder): Durchsucht Aufgaben, Dokumente, Projekte, Chats und Termine. Argumente: {"q":"suchbegriff","type":"task|doc|project|chat|calendar"} (type optional)`,
        ...tools.map(t => `- ${t.name} (ID: ${t.id}): ${t.description} [${t.config.method} ${t.config.url}]`),
    ];
    const toolsContext = `\nVERFÜGBARE TOOLS:\n${toolLines.join('\n')}\n\nUm ein Tool zu nutzen, schreibe exakt: [[TOOL:tool_id:{"arg":"value"}]]\nDas Tool wird automatisch ausgeführt und du erhältst das Ergebnis als [TOOL_RESULT]-Nachricht. Beantworte danach die Frage des Nutzers auf Basis des Ergebnisses.`;

    return `Du bist der Persönliche Assistent im Open Workspace. Deine Aufgaben:

KONTEXT:
- Der Nutzer befindet sich gerade im Modul: ${context.module}
- Modul-Beschreibung: ${context.moduleDescription}
- Aktuelle Seite: ${context.pathname}${viewStateContext}${toolsContext}

DEINE EIGENSCHAFTEN:
- Du sprichst den Nutzer immer mit "du" an (informell, nie "Sie")
- Du bist freundlich, hilfsbereit und präzise
- Du hast Zugriff auf alle Module des Workspaces
- Du kannst Aufgaben delegieren und koordinieren

DEINE FÄHIGKEITEN:
- Wissensbasis durchsuchen und bearbeiten (Professional Editor)
- Pinnwand-Karten (Canvas) erstellen und verknüpfen
- Aufgaben verwalten und priorisieren
- Global Finder nutzen (@task, @note, etc.)
- Code generieren und analysieren
- **Dynamische UI rendern (Agent2UI)**:
  Nutze einen Markdown Code-Block mit \`a2ui\` als Sprache, um UI-Komponenten zu rendern.
  Schema:
  \`\`\`a2ui
    {
        "components": [
            {
                "id": "my-card",
                "component": {
                    "Card": { "title": "Titel", "children": { "explicitList": ["img-1", "btn-1"] } }
                }
            },
            {
                "id": "img-1",
                "component": {
                    "Image": {
                        "src": "https://example.com/image.jpg",
                        "alt": "Beschreibung",
                        "caption": "Bildunterschrift"
                    }
                }
            },
            {
                "id": "btn-1",
                "component": {
                    "Button": { "label": "Aktion", "onPress": { "actionId": "clicked" } }
                }
            }
        ]
    }
    \`\`\`
  Verfügbare Komponenten & Props:
  - **Text**: \`text\` (string), \`style\` (object)
  - **Card**: \`title\` (string), \`children\` ({ explicitList: string[] })
  - **Button**: \`label\` (string), \`onPress\` ({ actionId: string })
  - **Image**: \`src\` (string URL), \`alt\` (string), \`caption\` (string)
  - **Markdown**: \`content\` (string markdown)
  - **CodeBlock**: \`code\` (string), \`language\` (string)
  - **Input**: \`label\`, \`value\`, \`placeholder\`, \`onChange\` ({ actionId })
  - **Layout**: \`Column\`, \`Row\` (\`gap\`, \`children\`)
  - **Alert**: \`title\`, \`message\`, \`variant\` ('info'|'warning'|'error'|'success')

HINWEIS: Das Modul "Canvas" wird im UI als "Pinnwand" bezeichnet.

Antworte immer auf Deutsch, es sei denn der Nutzer schreibt auf Englisch.
Halte deine Antworten präzise und hilfreich.`;
}

// Upper bound for LLM→tool→LLM cycles per request
const MAX_TOOL_ROUNDS = 3;
// Tool output is truncated before being fed back to the model
const MAX_TOOL_RESULT_CHARS = 4000;

/**
 * Built-in tool: workspace_finder — always available, no configuration
 * needed. Calls the internal finder endpoint (see TOOLS.md).
 */
async function runWorkspaceFinder(
    args: Record<string, unknown>,
    origin: string
): Promise<string> {
    const query = typeof args.q === 'string' ? args.q : String(args.query ?? '');
    if (!query) return 'Fehler: Parameter "q" (Suchbegriff) fehlt.';

    const url = new URL('/api/finder', origin);
    url.searchParams.set('q', query);
    if (typeof args.type === 'string') url.searchParams.set('type', args.type);

    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return `Fehler: Finder antwortete mit Status ${res.status}.`;
    const data = await res.json();
    const results = (data.results || []).slice(0, 10);
    if (results.length === 0) return `Keine Treffer für "${query}".`;
    return JSON.stringify(results);
}

/**
 * Execute a parsed tool call and return a summary string for the model.
 * Progress is surfaced to the user via emitText as markdown.
 */
async function runTool(
    toolId: string,
    rawArgs: string,
    emitText: (content: string) => void,
    origin: string
): Promise<string> {
    let args: Record<string, unknown> = {};
    if (rawArgs.trim()) {
        try {
            args = JSON.parse(rawArgs);
        } catch {
            emitText(`\n\n> ⚠️ Ungültige Argumente für \`${toolId}\`.\n\n`);
            return `Fehler: Argumente waren kein gültiges JSON: ${rawArgs.slice(0, 200)}`;
        }
    }

    if (toolId === 'workspace_finder') {
        emitText(`\n\n> 🔎 Durchsuche den Workspace…\n\n`);
        try {
            return await runWorkspaceFinder(args, origin);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
            return `Fehler bei der Suche: ${message}`;
        }
    }

    const tools = await loadTools();
    const tool = tools.find((t: Tool) => t.id === toolId);

    if (!tool) {
        emitText(`\n\n> ⚠️ Tool \`${toolId}\` nicht gefunden.\n\n`);
        return `Fehler: Tool "${toolId}" existiert nicht.`;
    }

    emitText(`\n\n> 🔧 Führe Tool **${tool.name}** aus…\n\n`);

    try {
        const result = await executeTool(tool, args as Record<string, any>);
        const serialized = typeof result === 'string' ? result : JSON.stringify(result);
        return serialized.length > MAX_TOOL_RESULT_CHARS
            ? serialized.slice(0, MAX_TOOL_RESULT_CHARS) + '… [gekürzt]'
            : serialized;
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
        emitText(`\n\n> ⚠️ Tool **${tool.name}** fehlgeschlagen: ${message}\n\n`);
        return `Fehler bei der Ausführung: ${message}`;
    }
}

export async function POST(request: NextRequest) {
    try {
        const body: ChatRequestBody = await request.json();
        const { messages, context, stream = false } = body;

        // Build full message array with system prompt
        const systemMessage: ChatMessage = {
            role: 'system',
            content: await buildSystemPrompt(context),
        };

        const fullMessages: ChatMessage[] = [
            systemMessage,
            ...messages.map((m) => ({
                role: m.role as 'user' | 'assistant',
                content: m.content,
            })),
        ];

        if (stream) {
            // Streaming response with a server-side tool loop: complete
            // [[TOOL:...]] calls are stripped from the visible stream,
            // executed, and their results fed back for a follow-up round.
            const encoder = new TextEncoder();
            const readable = new ReadableStream({
                async start(controller) {
                    const emit = (payload: Record<string, unknown>) => {
                        controller.enqueue(encoder.encode(JSON.stringify(payload) + '\n'));
                    };
                    const emitText = (content: string) => {
                        if (content) {
                            emit({ message: { role: 'assistant', content }, done: false });
                        }
                    };

                    try {
                        const history: ChatMessage[] = [...fullMessages];

                        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
                            const filter = new ToolCallStreamFilter();
                            let roundText = '';

                            for await (const chunk of chatStream(history)) {
                                const content = chunk.message?.content || '';
                                if (content) {
                                    roundText += content;
                                    emitText(filter.feed(content));
                                }
                            }
                            emitText(filter.flush());

                            if (filter.calls.length === 0) break;

                            // Record the assistant turn (incl. raw tool syntax)
                            history.push({ role: 'assistant', content: roundText });

                            const isLastRound = round === MAX_TOOL_ROUNDS - 1;
                            for (const call of filter.calls) {
                                const resultSummary = await runTool(call.toolId, call.rawArgs, emitText, request.nextUrl.origin);
                                history.push({
                                    role: 'user',
                                    content: `[TOOL_RESULT ${call.toolId}]: ${resultSummary}` +
                                        (isLastRound
                                            ? '\n(Hinweis: Tool-Limit erreicht — fasse jetzt zusammen, ohne weitere Tools aufzurufen.)'
                                            : '\nFasse das Ergebnis für den Nutzer verständlich zusammen.'),
                                });
                            }
                        }
                        controller.close();
                    } catch (error) {
                        // Send error as a special chunk so client can display it
                        // instead of the stream just dying with "Failed to fetch"
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
        } else {
            // Non-streaming response
            const response = await chat(fullMessages);
            return NextResponse.json({
                message: response.message,
                done: response.done,
            });
        }
    } catch (error) {
        console.error('Chat API error:', error);
        return NextResponse.json(
            {
                error: 'Verbindung zum AI-Server fehlgeschlagen. Stelle sicher, dass Ollama läuft.',
                details: error instanceof Error ? error.message : 'Unknown error'
            },
            { status: 500 }
        );
    }
}
