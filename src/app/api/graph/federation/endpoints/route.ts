/**
 * Föderierte SPARQL-Endpoints (GRAPH_CORE_SPEC §7.4, M11) — Route-Adapter
 * der Aktionen `graph_list_federation_endpoints` und
 * `graph_create_federation_endpoint`.
 */

import type { NextRequest } from 'next/server';
import { actionErrorResponse, readJsonBody, respondWithAction } from '@/lib/actions/route';
import { createEndpoint, listEndpoints } from '@/lib/graph/federation/actions';

export async function GET() {
    return respondWithAction(listEndpoints, {});
}

export async function POST(request: NextRequest) {
    try {
        return await respondWithAction(createEndpoint, await readJsonBody(request), { status: 201 });
    } catch (error) {
        return actionErrorResponse(error);
    }
}
