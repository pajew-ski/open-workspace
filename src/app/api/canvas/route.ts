/**
 * Pinnwände — Route-Adapter der Canvas-Aktionen (ACTIONS_SPEC §3). Die
 * Route ist aktionsbasiert: `{ action: 'createCard', … }` wählt über den
 * Diskriminator die Aktion, der Rest des Bodys ist ihre Eingabe.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { readJsonBody, respondWithAction, actionErrorResponse } from '@/lib/actions/route';
import { CANVAS_ACTIONS_BY_KIND, getCanvas, listCanvases } from '@/lib/graph/workspace/actions';

/** Welche Aktionen mit 201 antworten (Anlegen). */
const CREATED = new Set(['create', 'import', 'createCard', 'createConnection']);

export async function GET(request: NextRequest) {
    const id = new URL(request.url).searchParams.get('id');
    if (id) {
        return respondWithAction(getCanvas, { id }, { shape: output => (output as { canvas: unknown }).canvas });
    }
    return respondWithAction(listCanvases, {});
}

export async function POST(request: NextRequest) {
    try {
        const body = await readJsonBody(request);
        const { action: kind, ...input } = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
        const action = typeof kind === 'string' && kind in CANVAS_ACTIONS_BY_KIND
            ? CANVAS_ACTIONS_BY_KIND[kind as keyof typeof CANVAS_ACTIONS_BY_KIND]
            : null;
        if (!action) return NextResponse.json({ error: 'Unbekannte Aktion' }, { status: 400 });
        return await respondWithAction(action, input, { status: typeof kind === 'string' && CREATED.has(kind) ? 201 : 200 });
    } catch (error) {
        return actionErrorResponse(error);
    }
}
