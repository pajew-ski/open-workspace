/**
 * Multi-Hop-Retrieval (SPEC §7.5, M8) — Route-Adapter der Aktion
 * `graph_retrieve` (ACTIONS_SPEC §3, A2).
 *
 * POST /api/graph/retrieve
 * Body: RetrievalRequest (partiell, Defaults nach §7.5) plus optional
 * `profile` (ID eines gespeicherten ow:RetrievalProfile — dessen
 * Parameter bilden die Basis, der Body überschreibt feldweise).
 */

import { readJsonBody, respondWithAction, actionErrorResponse } from '@/lib/actions/route';
import { graphRetrieve } from '@/lib/graph/mcp/actions';

export async function POST(request: Request): Promise<Response> {
    try {
        return await respondWithAction(graphRetrieve, await readJsonBody(request));
    } catch (error) {
        return actionErrorResponse(error);
    }
}
