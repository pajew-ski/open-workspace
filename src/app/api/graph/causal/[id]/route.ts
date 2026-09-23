/**
 * Ein Kausalmodell (CAUSAL_LAYER_SPEC §5, C0/C1) — Route-Adapter der
 * Aktionen `causal_get_model`, `causal_edit_model` (PATCH: genau eine
 * Strukturänderung) und `causal_delete_model`.
 */

import type { NextRequest } from 'next/server';
import { actionErrorResponse, readJsonBody, respondWithAction } from '@/lib/actions/route';
import { deleteModel, editModel, getModel } from '@/lib/graph/causal/actions.server';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    return respondWithAction(getModel, { id });
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    try {
        return await respondWithAction(editModel, { id, operation: await readJsonBody(request) });
    } catch (error) {
        return actionErrorResponse(error);
    }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    return respondWithAction(deleteModel, { id });
}
