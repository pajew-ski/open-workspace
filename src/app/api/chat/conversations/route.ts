import { NextRequest, NextResponse } from 'next/server';
import {
    listConversations,
    getConversation,
    createConversation,
    addMessage,
    updateMessage,
    renameConversation,
    deleteConversation,
    setActiveConversation,
    getActiveId,
    clearAllConversations,
} from '@/lib/storage';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const id = searchParams.get('id');

        if (id) {
            const conversation = await getConversation(id);
            if (!conversation) {
                return NextResponse.json({ error: 'Konversation nicht gefunden' }, { status: 404 });
            }
            return NextResponse.json(conversation);
        }

        const conversations = await listConversations();
        const activeId = await getActiveId();
        return NextResponse.json({ conversations, activeId });
    } catch (error) {
        console.error('Conversations get error:', error);
        return NextResponse.json({ error: 'Fehler beim Laden' }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { action } = body;

        switch (action) {
            case 'create': {
                const conversation = await createConversation(body.title);
                return NextResponse.json({ conversation }, { status: 201 });
            }

            case 'addMessage': {
                const message = await addMessage(body.conversationId, body.role, body.content);
                if (!message) {
                    return NextResponse.json({ error: 'Konversation nicht gefunden' }, { status: 404 });
                }
                return NextResponse.json({ message }, { status: 201 });
            }

            case 'updateMessage': {
                const message = await updateMessage(body.conversationId, body.messageId, body.content);
                if (!message) {
                    return NextResponse.json({ error: 'Nachricht nicht gefunden' }, { status: 404 });
                }
                return NextResponse.json({ message });
            }

            case 'rename': {
                const conversation = await renameConversation(body.id, body.title);
                if (!conversation) {
                    return NextResponse.json({ error: 'Konversation nicht gefunden' }, { status: 404 });
                }
                return NextResponse.json({ conversation });
            }

            case 'delete': {
                const success = await deleteConversation(body.id);
                if (!success) {
                    return NextResponse.json({ error: 'Konversation nicht gefunden' }, { status: 404 });
                }
                return NextResponse.json({ success: true });
            }

            case 'setActive': {
                await setActiveConversation(body.id);
                return NextResponse.json({ success: true });
            }

            case 'clearAll': {
                await clearAllConversations();
                return NextResponse.json({ success: true });
            }

            default:
                return NextResponse.json({ error: 'Unbekannte Aktion' }, { status: 400 });
        }
    } catch (error) {
        console.error('Conversations action error:', error);
        return NextResponse.json({ error: 'Aktion fehlgeschlagen' }, { status: 500 });
    }
}
