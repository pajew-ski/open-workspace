/** Skills — Route-Adapter der Aktionen `skills_list` und `skills_create` (ACTIONS_SPEC §3). */

import type { NextRequest } from 'next/server';
import { readJsonBody, respondWithAction, actionErrorResponse } from '@/lib/actions/route';
import { createSkillAction, listSkills } from '@/lib/skills/actions.server';

export async function GET() {
    return respondWithAction(listSkills, {});
}

export async function POST(request: NextRequest) {
    try {
        return await respondWithAction(createSkillAction, await readJsonBody(request), { status: 201 });
    } catch (error) {
        return actionErrorResponse(error);
    }
}
