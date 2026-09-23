/** Voreinstellung — Route-Adapter der Aktion `ai_set_defaults` (ACTIONS_SPEC §3). */

import type { NextRequest } from 'next/server';
import { readJsonBody, respondWithAction, actionErrorResponse } from '@/lib/actions/route';
import { aiSetDefaults } from '@/lib/ai/actions.server';

export async function PUT(request: NextRequest) {
    try {
        return await respondWithAction(aiSetDefaults, await readJsonBody(request));
    } catch (error) {
        return actionErrorResponse(error);
    }
}
