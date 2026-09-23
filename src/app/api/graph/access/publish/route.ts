/**
 * POST /api/graph/access/publish — Route-Adapter der Aktion
 * `access_publish` (SPEC §17.2): einen Knoten in einen anderen Graphen
 * kopieren oder verschieben.
 */

import type { NextRequest } from 'next/server';
import { actionErrorResponse, readJsonBody, respondWithAction } from '@/lib/actions/route';
import { publishAction } from '@/lib/graph/authz/actions';

export async function POST(request: NextRequest) {
    try {
        return await respondWithAction(publishAction, await readJsonBody(request));
    } catch (error) {
        return actionErrorResponse(error);
    }
}
