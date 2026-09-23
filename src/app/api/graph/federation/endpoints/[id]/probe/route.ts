/**
 * POST /api/graph/federation/endpoints/<id>/probe — Route-Adapter der
 * Aktion `graph_probe_federation_endpoint` (eine echte ASK-Query).
 */

import type { NextRequest } from 'next/server';
import { respondWithAction } from '@/lib/actions/route';
import { probeEndpointAction } from '@/lib/graph/federation/actions';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function POST(_request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    return respondWithAction(probeEndpointAction, { id });
}
