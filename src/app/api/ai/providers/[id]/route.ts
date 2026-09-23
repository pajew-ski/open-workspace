/** Ein Provider — Route-Adapter der Aktionen `ai_update_provider` und `ai_delete_provider` (ACTIONS_SPEC §3). */

import type { NextRequest } from 'next/server';
import { readJsonBody, respondWithAction, actionErrorResponse } from '@/lib/actions/route';
import { aiDeleteProvider, aiUpdateProvider } from '@/lib/ai/actions.server';

interface RouteContext {
    params: Promise<{ id: string }>;
}

export async function PUT(request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    try {
        const body = await readJsonBody(request);
        return await respondWithAction(aiUpdateProvider, { ...(body as object), id });
    } catch (error) {
        return actionErrorResponse(error);
    }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    return respondWithAction(aiDeleteProvider, { id });
}
