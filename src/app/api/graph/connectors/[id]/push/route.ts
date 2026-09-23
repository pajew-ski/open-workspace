/**
 * POST /api/graph/connectors/<id>/push — Route-Adapter der Aktion
 * `graph_push_connector` (Export in die Quelle, Konfliktregel SPEC §6.2).
 */

import type { NextRequest } from 'next/server';
import { respondWithAction } from '@/lib/actions/route';
import { pushConnectorAction } from '@/lib/graph/connectors/actions';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function POST(_request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    return respondWithAction(pushConnectorAction, { id });
}
