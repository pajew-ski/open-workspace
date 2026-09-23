/**
 * Unterhaltungen — Route-Adapter der Aktionen `chat_*` (ACTIONS_SPEC §3).
 * Aktionsbasiert: `{ action: 'addMessage', … }` wählt die Aktion.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { readJsonBody, respondWithAction, actionErrorResponse } from '@/lib/actions/route';
import { CONVERSATION_ACTIONS_BY_KIND, getConversation, listConversations } from '@/lib/graph/workspace/actions';

const CREATED = new Set(['create', 'addMessage']);

export async function GET(request: NextRequest) {
    const id = new URL(request.url).searchParams.get('id');
    if (id) {
        return respondWithAction(getConversation, { id }, { shape: output => (output as { conversation: unknown }).conversation });
    }
    return respondWithAction(listConversations, {});
}

export async function POST(request: NextRequest) {
    try {
        const body = await readJsonBody(request);
        const { action: kind, ...input } = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
        const action = typeof kind === 'string' && kind in CONVERSATION_ACTIONS_BY_KIND
            ? CONVERSATION_ACTIONS_BY_KIND[kind as keyof typeof CONVERSATION_ACTIONS_BY_KIND]
            : null;
        if (!action) return NextResponse.json({ error: 'Unbekannte Aktion' }, { status: 400 });
        return await respondWithAction(action, input, { status: typeof kind === 'string' && CREATED.has(kind) ? 201 : 200 });
    } catch (error) {
        return actionErrorResponse(error);
    }
}
