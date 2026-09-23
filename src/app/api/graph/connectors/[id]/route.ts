/**
 * Eine Connector-Instanz — Route-Adapter der Aktionen
 * `graph_get_connector` und `graph_delete_connector`.
 */

import type { NextRequest } from 'next/server';
import { respondWithAction } from '@/lib/actions/route';
import { deleteConnectorAction, getConnectorAction } from '@/lib/graph/connectors/actions';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    return respondWithAction(getConnectorAction, { id });
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    return respondWithAction(deleteConnectorAction, { id });
}
