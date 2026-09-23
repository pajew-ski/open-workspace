/**
 * POST /api/graph/views/preview — Route-Adapter der Aktion
 * `graph_preview_query` (CONSTRUCT/DESCRIBE als Subgraph, ohne Speichern).
 */

import type { NextRequest } from 'next/server';
import { actionErrorResponse, readJsonBody, respondWithAction } from '@/lib/actions/route';
import { previewQuery } from '@/lib/graph/views/actions.server';

export async function POST(request: NextRequest) {
    try {
        return await respondWithAction(previewQuery, await readJsonBody(request));
    } catch (error) {
        return actionErrorResponse(error);
    }
}
