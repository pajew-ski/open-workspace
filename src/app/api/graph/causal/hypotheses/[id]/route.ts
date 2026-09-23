/**
 * Einen Vorschlag übernehmen oder verwerfen (CAUSAL_LAYER_SPEC §8, C6) —
 * Route-Adapter der Aktionen `causal_adopt_hypothesis` (POST) und
 * `causal_discard_hypothesis` (DELETE).
 */

import type { NextRequest } from 'next/server';
import { respondWithAction } from '@/lib/actions/route';
import { adoptHypothesisAction, discardHypothesisAction } from '@/lib/graph/causal/actions.server';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function POST(_request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    return respondWithAction(adoptHypothesisAction, { id });
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    return respondWithAction(discardHypothesisAction, { id });
}
