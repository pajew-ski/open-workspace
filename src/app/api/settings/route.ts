/** Einstellungen — Route-Adapter der Aktionen `settings_get` und `settings_update` (ACTIONS_SPEC §3). */

import type { NextRequest } from 'next/server';
import { readJsonBody, respondWithAction, actionErrorResponse } from '@/lib/actions/route';
import { getSettings, updateSettings } from '@/lib/app/actions';

export async function GET() {
    return respondWithAction(getSettings, {});
}

export async function PUT(request: NextRequest) {
    try {
        return await respondWithAction(updateSettings, await readJsonBody(request));
    } catch (error) {
        return actionErrorResponse(error);
    }
}
