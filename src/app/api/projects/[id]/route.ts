/**
 * Ein Projekt — Route-Adapter der Aktionen `workspace_get_project`,
 * `workspace_update_project` und `workspace_delete_project` (ACTIONS_SPEC §3).
 */

import type { NextRequest } from 'next/server';
import { readJsonBody, respondWithAction, actionErrorResponse } from '@/lib/actions/route';
import { deleteProject, getProject, updateProject } from '@/lib/graph/workspace/actions';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    return respondWithAction(getProject, { id });
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    try {
        const body = await readJsonBody(request);
        return await respondWithAction(updateProject, { ...(body as object), projectId: id });
    } catch (error) {
        return actionErrorResponse(error);
    }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    return respondWithAction(deleteProject, { id });
}
