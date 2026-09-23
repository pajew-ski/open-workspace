/**
 * POST /api/graph/access/groups — Route-Adapter der Aktion
 * `access_set_group` (SPEC §17.1; Gruppen sind instanzweit).
 */

import type { NextRequest } from 'next/server';
import { actionErrorResponse, readJsonBody, respondWithAction } from '@/lib/actions/route';
import { setGroupAction } from '@/lib/graph/authz/actions';

export async function POST(request: NextRequest) {
    try {
        return await respondWithAction(setGroupAction, await readJsonBody(request), { status: 201 });
    } catch (error) {
        return actionErrorResponse(error);
    }
}
