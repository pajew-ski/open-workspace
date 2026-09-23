/**
 * Ein föderierter Endpoint — Route-Adapter der Aktionen
 * `graph_get_federation_endpoint`, `graph_update_federation_endpoint`
 * und `graph_delete_federation_endpoint`.
 */

import type { NextRequest } from 'next/server';
import { actionErrorResponse, readJsonBody, respondWithAction } from '@/lib/actions/route';
import { deleteEndpoint, getEndpoint, updateEndpoint } from '@/lib/graph/federation/actions';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    return respondWithAction(getEndpoint, { id });
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    try {
        const body = await readJsonBody(request);
        return await respondWithAction(updateEndpoint, { ...(body as object), id });
    } catch (error) {
        return actionErrorResponse(error);
    }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    return respondWithAction(deleteEndpoint, { id });
}
