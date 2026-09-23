/**
 * `POST /api/actions/<name>` — Ausführung einer Aktion für den
 * Browser-Loop (ACTIONS_SPEC §3). Derselbe Adapter wie jede Route:
 * parsen, `ctx` aus der Anfrage, `run`. Erreichbar sind nur die
 * Effektklassen, die ein Agent sieht — `destructive` bleibt der
 * bestätigten Oberfläche vorbehalten und antwortet hier wie Unbekanntes.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { getAction } from '@/lib/actions/registry';
import { readJsonBody, respondWithActionInvocation, actionErrorResponse } from '@/lib/actions/route';
import { AGENT_VISIBLE_EFFECTS } from '@/lib/actions/tools';
import '@/lib/actions/catalog';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, context: { params: Promise<{ name: string }> }): Promise<Response> {
    const { name } = await context.params;
    const action = getAction(name);
    if (!action || !AGENT_VISIBLE_EFFECTS.includes(action.effect)) {
        return NextResponse.json({ error: `Aktion "${name}" existiert nicht.` }, { status: 404 });
    }
    try {
        return await respondWithActionInvocation(action, await readJsonBody(request), {
            origin: request.nextUrl.origin,
        });
    } catch (error) {
        return actionErrorResponse(error, name);
    }
}
