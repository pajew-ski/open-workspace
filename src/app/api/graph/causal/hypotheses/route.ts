/**
 * Vorschläge: der Lauf der neurosymbolischen Schleife (CAUSAL_LAYER_SPEC
 * §8, C6) — Route-Adapter der Aktionen `causal_list_hypotheses` und
 * `causal_propose`.
 */

import type { NextRequest } from 'next/server';
import { actionErrorResponse, readJsonBody, respondWithAction } from '@/lib/actions/route';
import { listHypotheses, proposeAction } from '@/lib/graph/causal/actions.server';

/** Drei Quellen, dazu die Filterstrecke — das dauert, aber nicht ewig. */
export const maxDuration = 120;

export async function GET() {
    return respondWithAction(listHypotheses, {});
}

export async function POST(request: NextRequest) {
    try {
        return await respondWithAction(proposeAction, await readJsonBody(request));
    } catch (error) {
        return actionErrorResponse(error);
    }
}
