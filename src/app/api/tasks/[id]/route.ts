/**
 * Eine Aufgabe — Route-Adapter der Aktionen `workspace_get_task`,
 * `workspace_update_task` und `workspace_delete_task` (ACTIONS_SPEC §3).
 * Löschen ist destruktiv: Die Oberfläche holt davor die Bestätigung ein.
 */

import type { NextRequest } from 'next/server';
import { readJsonBody, respondWithAction, actionErrorResponse } from '@/lib/actions/route';
import { deleteTask, getTask, updateTask } from '@/lib/graph/workspace/actions';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    return respondWithAction(getTask, { id });
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    try {
        const body = await readJsonBody(request);
        return await respondWithAction(updateTask, { ...(body as object), taskId: id });
    } catch (error) {
        return actionErrorResponse(error);
    }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    return respondWithAction(deleteTask, { id });
}
