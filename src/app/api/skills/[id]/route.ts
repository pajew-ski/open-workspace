/** Ein Skill — Route-Adapter der Aktionen `skills_update` und `skills_delete` (ACTIONS_SPEC §3). */

import type { NextRequest } from 'next/server';
import { readJsonBody, respondWithAction, actionErrorResponse } from '@/lib/actions/route';
import { deleteSkillAction, updateSkillAction } from '@/lib/skills/actions.server';

interface RouteContext {
    params: Promise<{ id: string }>;
}

export async function PUT(request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    try {
        const body = await readJsonBody(request);
        return await respondWithAction(updateSkillAction, { ...(body as object), id });
    } catch (error) {
        return actionErrorResponse(error);
    }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    return respondWithAction(deleteSkillAction, { id });
}
