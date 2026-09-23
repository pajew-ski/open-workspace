/**
 * `GET /api/actions` — die Tool-Definitionen des Aufrufers (ACTIONS_SPEC
 * §3): dieselben Definitionen, die der Server-Loop verwendet, für den
 * Browser-Loop. Sichtbar sind `read` und `constructive`, und nur, was
 * dieser Grant erreicht.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { actionContextFromRequest } from '@/lib/actions/context.server';
import type { ActionSurface } from '@/lib/actions/contract';
import { actionErrorResponse } from '@/lib/actions/route';
import { visibleToolDefinitions } from '@/lib/actions/tools';

export const dynamic = 'force-dynamic';

/**
 * `?surface=1`: Der Aufrufer hat eine Oberfläche (das Chat-Widget) und
 * führt Oberflächen-Aktionen selbst aus (A3) — die Liste enthält sie
 * dann. Für die Auflistung reicht ein Platzhalter; ausgeführt wird hier
 * nichts.
 */
const LISTING_SURFACE: ActionSurface = {
    pathname: () => '/',
    viewState: () => ({}),
    module: () => null,
    activeSurface: () => [],
    freshness: 'request',
};

export async function GET(request: NextRequest): Promise<Response> {
    try {
        const withSurface = request.nextUrl.searchParams.get('surface') === '1';
        const ctx = await actionContextFromRequest(withSurface ? { surface: LISTING_SURFACE } : {});
        return NextResponse.json({ actions: await visibleToolDefinitions(ctx) });
    } catch (error) {
        return actionErrorResponse(error, 'Aktionsliste');
    }
}
