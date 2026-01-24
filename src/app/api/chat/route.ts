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
    };
    stream?: boolean;
}

/**
 * Build system prompt with context awareness
 */
function buildSystemPrompt(context: ChatRequestBody['context']): string {
    return `Du bist der Persönliche Assistent im Open Workspace. Deine Aufgaben:

KONTEXT:
- Der Nutzer befindet sich gerade im Modul: ${context.module}
- Modul-Beschreibung: ${context.moduleDescription}
- Aktuelle Seite: ${context.pathname}

DEINE EIGENSCHAFTEN:
- Du sprichst den Nutzer immer mit "du" an (informell, nie "Sie")
- Du bist freundlich, hilfsbereit und präzise
- Du hast Zugriff auf alle Module des Workspaces
- Du kannst Aufgaben delegieren und koordinieren

DEINE FÄHIGKEITEN:
- Wissensbasis durchsuchen und Notizen erstellen
- Pinnwand-Karten (Canvas) erstellen und verknüpfen
- Aufgaben verwalten und priorisieren
- Code analysieren und generieren
- Markdown-Dokumente erstellen

HINWEIS: Das Modul "Canvas" wird im UI als "Pinnwand" bezeichnet. Wenn der Nutzer von "Pinnwand" spricht, ist das Canvas-Modul gemeint.

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
            content: buildSystemPrompt(context),
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
                        controller.error(error);
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
