/**
 * DELETE /api/graph/causal/estimands/<id> — Route-Adapter der Aktion
 * `causal_delete_estimand`.
 */

import type { NextRequest } from 'next/server';
import { respondWithAction } from '@/lib/actions/route';
import { deleteEstimandAction } from '@/lib/graph/causal/actions.server';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    return respondWithAction(deleteEstimandAction, { id });
}
