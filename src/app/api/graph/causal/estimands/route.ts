/**
 * Fragen an ein Kausalmodell (`ow:Estimand`, C4) — Route-Adapter der
 * Aktionen `causal_list_estimands` und `causal_create_estimand`.
 */

import type { NextRequest } from 'next/server';
import { actionErrorResponse, readJsonBody, respondWithAction } from '@/lib/actions/route';
import { createEstimandAction, listEstimandsAction } from '@/lib/graph/causal/actions.server';

export async function GET() {
    return respondWithAction(listEstimandsAction, {});
}

export async function POST(request: NextRequest) {
    try {
        return await respondWithAction(createEstimandAction, await readJsonBody(request), { status: 201 });
    } catch (error) {
        return actionErrorResponse(error);
    }
}
