/**
 * Beobachtungsgrößen (CAUSAL_LAYER_SPEC §5/§6) — Route-Adapter der
 * Aktionen `observations_overview` und `observations_create_variable`.
 */

import type { NextRequest } from 'next/server';
import { actionErrorResponse, readJsonBody, respondWithAction } from '@/lib/actions/route';
import { createVariableAction, observationsOverview } from '@/lib/graph/observations/actions.server';

export async function GET() {
    return respondWithAction(observationsOverview, {});
}

export async function POST(request: NextRequest) {
    try {
        return await respondWithAction(createVariableAction, await readJsonBody(request), { status: 201 });
    } catch (error) {
        return actionErrorResponse(error);
    }
}
