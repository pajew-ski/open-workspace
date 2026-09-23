/**
 * Kalender — Route-Adapter der Aktionen `calendar_*` (ACTIONS_SPEC §3).
 * Aktionsbasiert: `{ action: 'addProvider', … }` wählt die Aktion.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { readJsonBody, respondWithAction, actionErrorResponse } from '@/lib/actions/route';
import { CALENDAR_ACTIONS_BY_KIND, listCalendars, listEvents } from '@/lib/graph/workspace/actions';

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    if (searchParams.get('action') === 'events') {
        return respondWithAction(listEvents, {
            ...(searchParams.get('start') ? { start: searchParams.get('start') } : {}),
            ...(searchParams.get('end') ? { end: searchParams.get('end') } : {}),
            limit: 1000,
        });
    }
    return respondWithAction(listCalendars, {});
}

export async function POST(request: NextRequest) {
    try {
        const body = await readJsonBody(request);
        const { action: kind, ...input } = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
        const action = typeof kind === 'string' && kind in CALENDAR_ACTIONS_BY_KIND
            ? CALENDAR_ACTIONS_BY_KIND[kind as keyof typeof CALENDAR_ACTIONS_BY_KIND]
            : null;
        if (!action) return NextResponse.json({ error: 'Unbekannte Aktion' }, { status: 400 });
        return await respondWithAction(action, input, { status: kind === 'addProvider' ? 201 : 200 });
    } catch (error) {
        return actionErrorResponse(error);
    }
}
