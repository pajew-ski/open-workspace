/**
 * `GET /api/actions` — die Tool-Definitionen des Aufrufers (ACTIONS_SPEC
 * §3): dieselben Definitionen, die der Server-Loop verwendet, für den
 * Browser-Loop. Sichtbar sind `read` und `constructive`, und nur, was
 * dieser Grant erreicht.
 */

import { NextResponse } from 'next/server';
import { actionContextFromRequest } from '@/lib/actions/context.server';
import { actionErrorResponse } from '@/lib/actions/route';
import { visibleToolDefinitions } from '@/lib/actions/tools';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
    try {
        const ctx = await actionContextFromRequest();
        return NextResponse.json({ actions: await visibleToolDefinitions(ctx) });
    } catch (error) {
        return actionErrorResponse(error, 'Aktionsliste');
    }
}
