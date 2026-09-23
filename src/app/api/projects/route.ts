/**
 * Projekte — Route-Adapter der Aktionen `workspace_list_projects` und
 * `workspace_create_project` (ACTIONS_SPEC §3).
 */

import type { NextRequest } from 'next/server';
import { readJsonBody, respondWithAction, actionErrorResponse } from '@/lib/actions/route';
import { createProject, listProjects } from '@/lib/graph/workspace/actions';

export async function GET() {
    return respondWithAction(listProjects, {});
}

export async function POST(request: NextRequest) {
    try {
        return await respondWithAction(createProject, await readJsonBody(request), { status: 201 });
    } catch (error) {
        return actionErrorResponse(error);
    }
}
