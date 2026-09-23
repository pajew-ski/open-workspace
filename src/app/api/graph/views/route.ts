/**
 * Gespeicherte Queries (GRAPH_CORE_SPEC §9, M5) — Route-Adapter der
 * Aktionen `graph_list_views` und `graph_create_view`.
 */

import type { NextRequest } from 'next/server';
import { actionErrorResponse, readJsonBody, respondWithAction } from '@/lib/actions/route';
import { createView, listViews } from '@/lib/graph/views/actions.server';

export async function GET() {
    return respondWithAction(listViews, {});
}

export async function POST(request: NextRequest) {
    try {
        return await respondWithAction(createView, await readJsonBody(request), { status: 201 });
    } catch (error) {
        return actionErrorResponse(error);
    }
}
