/**
 * Ein Dokument — Route-Adapter der Aktionen `workspace_get_doc`,
 * `workspace_update_doc` und `workspace_delete_doc` (ACTIONS_SPEC §3).
 */

import type { NextRequest } from 'next/server';
import { readJsonBody, respondWithAction, actionErrorResponse } from '@/lib/actions/route';
import { deleteDoc, getDoc, updateDoc } from '@/lib/graph/workspace/actions';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    return respondWithAction(getDoc, { id });
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    try {
        const body = await readJsonBody(request);
        return await respondWithAction(updateDoc, { ...(body as object), docId: id });
    } catch (error) {
        return actionErrorResponse(error);
    }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    return respondWithAction(deleteDoc, { id });
}
