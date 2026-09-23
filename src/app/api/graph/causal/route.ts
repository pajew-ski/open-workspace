/**
 * Kausalmodelle (CAUSAL_LAYER_SPEC §5) — Route-Adapter der Aktionen
 * `causal_overview` und `causal_create_model`.
 */

import type { NextRequest } from 'next/server';
import { actionErrorResponse, readJsonBody, respondWithAction } from '@/lib/actions/route';
import { causalOverview, createModel } from '@/lib/graph/causal/actions.server';

export async function GET() {
    return respondWithAction(causalOverview, {});
}

export async function POST(request: NextRequest) {
    try {
        return await respondWithAction(createModel, await readJsonBody(request), { status: 201 });
    } catch (error) {
        return actionErrorResponse(error);
    }
}
