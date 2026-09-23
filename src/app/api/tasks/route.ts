/**
 * Aufgaben — Route-Adapter der Aktionen `workspace_list_tasks` und
 * `workspace_create_task` (ACTIONS_SPEC §3).
 */

import type { NextRequest } from 'next/server';
import { readJsonBody, respondWithAction, actionErrorResponse } from '@/lib/actions/route';
import { createTask, listTasks } from '@/lib/graph/workspace/actions';

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    return respondWithAction(listTasks, {
        ...(searchParams.get('groupBy') ? { groupBy: searchParams.get('groupBy') } : {}),
        ...(searchParams.get('status') ? { status: searchParams.get('status') } : {}),
        ...(searchParams.get('projectId') ? { projectId: searchParams.get('projectId') } : {}),
        limit: 500,
    });
}

export async function POST(request: NextRequest) {
    try {
        return await respondWithAction(createTask, await readJsonBody(request), { status: 201 });
    } catch (error) {
        return actionErrorResponse(error);
    }
}
