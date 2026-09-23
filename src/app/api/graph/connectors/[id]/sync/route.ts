/**
 * POST /api/graph/connectors/<id>/sync — Route-Adapter der Aktion
 * `graph_sync_connector` (Import mit Replace-Semantik und Quarantäne).
 */

import type { NextRequest } from 'next/server';
import { respondWithAction } from '@/lib/actions/route';
import { syncConnectorAction } from '@/lib/graph/connectors/actions';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function POST(_request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    return respondWithAction(syncConnectorAction, { id });
}
