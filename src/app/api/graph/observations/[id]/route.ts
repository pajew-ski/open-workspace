/**
 * Eine Beobachtungsgröße — Route-Adapter der Aktionen
 * `observations_get_variable`, `observations_update_variable` und
 * `observations_delete_variable` (`?purge=1` löscht auch den Bestand).
 */

import type { NextRequest } from 'next/server';
import { actionErrorResponse, readJsonBody, respondWithAction } from '@/lib/actions/route';
import { deleteVariableAction, getVariableAction, updateVariableAction } from '@/lib/graph/observations/actions.server';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    return respondWithAction(getVariableAction, { id });
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    try {
        const body = await readJsonBody(request);
        return await respondWithAction(updateVariableAction, { ...(body as object), id });
    } catch (error) {
        return actionErrorResponse(error);
    }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    const purge = new URL(request.url).searchParams.get('purge') === '1';
    return respondWithAction(deleteVariableAction, { id, purge });
}
