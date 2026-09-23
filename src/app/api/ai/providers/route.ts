/** Provider anlegen — Route-Adapter der Aktion `ai_create_provider` (ACTIONS_SPEC §3). */

import type { NextRequest } from 'next/server';
import { readJsonBody, respondWithAction, actionErrorResponse } from '@/lib/actions/route';
import { aiCreateProvider } from '@/lib/ai/actions.server';

export async function POST(request: NextRequest) {
    try {
        return await respondWithAction(aiCreateProvider, await readJsonBody(request), { status: 201 });
    } catch (error) {
        return actionErrorResponse(error);
    }
}
