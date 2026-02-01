import { NextRequest, NextResponse } from 'next/server';
import { chat, chatStream, ChatMessage } from '@/lib/inference';

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

    // Load available tools
    const tools = await loadTools();
    const toolsContext = tools.length > 0
        ? `\nVERFÜGBARE TOOLS:\n${tools.map(t => `- ${t.name} (ID: ${t.id}): ${t.description} [${t.config.method} ${t.config.url}]`).join('\n')}\n\nUm ein Tool zu nutzen, antworte NUR mit: [[TOOL:tool_id:{"arg":"value"}]]`
        : '';

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
            // Return streaming response
            const encoder = new TextEncoder();
            const readable = new ReadableStream({
                async start(controller) {
                    try {
                        for await (const chunk of chatStream(fullMessages)) {
                            const data = JSON.stringify(chunk) + '\n';
                            controller.enqueue(encoder.encode(data));
                        }
                        controller.close();
                    } catch (error) {
                        // Send error as a special chunk so client can display it
                        // instead of the stream just dying with "Failed to fetch"
                        const errorMessage = error instanceof Error ? error.message : 'Unknown stream error';
                        const errorChunk = JSON.stringify({
                            error: errorMessage,
                            done: true
                        }) + '\n';
                        controller.enqueue(encoder.encode(errorChunk));
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
