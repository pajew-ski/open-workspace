/**
 * Connector-Instanzen (GRAPH_CORE_SPEC §6) — Route-Adapter der Aktionen
 * `graph_list_connectors` und `graph_create_connector`.
 */

import type { NextRequest } from 'next/server';
import { actionErrorResponse, readJsonBody, respondWithAction } from '@/lib/actions/route';
import { createConnectorAction, listConnectorsAction } from '@/lib/graph/connectors/actions';

export async function GET() {
    return respondWithAction(listConnectorsAction, {});
}

export async function POST(request: NextRequest) {
    try {
        return await respondWithAction(createConnectorAction, await readJsonBody(request), { status: 201 });
    } catch (error) {
        return actionErrorResponse(error);
    }
}
