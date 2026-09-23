/**
 * POST /api/graph/validate — Route-Adapter der Aktion `graph_validate`
 * (SHACL-Befund, berichtend). Ohne Body werden alle erlaubten Graphen
 * geprüft.
 */

import type { NextRequest } from 'next/server';
import { actionErrorResponse, readJsonBody, respondWithAction } from '@/lib/actions/route';
import { validate } from '@/lib/graph/reasoning/actions';

export async function POST(request: NextRequest) {
    try {
        return await respondWithAction(validate, await readJsonBody(request));
    } catch (error) {
        return actionErrorResponse(error);
    }
}
