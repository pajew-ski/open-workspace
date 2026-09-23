/**
 * Geteilte Räume (SPEC §17.2, M13) — Route-Adapter der Aktionen
 * `access_list_spaces` und `access_create_space`.
 */

import type { NextRequest } from 'next/server';
import { actionErrorResponse, readJsonBody, respondWithAction } from '@/lib/actions/route';
import { createSpaceAction, listSpacesAction } from '@/lib/graph/authz/actions';

export const dynamic = 'force-dynamic';

export async function GET() {
    return respondWithAction(listSpacesAction, {});
}

export async function POST(request: NextRequest) {
    try {
        return await respondWithAction(createSpaceAction, await readJsonBody(request), { status: 201 });
    } catch (error) {
        return actionErrorResponse(error);
    }
}
