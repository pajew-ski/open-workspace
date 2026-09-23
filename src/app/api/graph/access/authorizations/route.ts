/**
 * POST /api/graph/access/authorizations — Route-Adapter der Aktion
 * `access_set_authorization` (SPEC §17.1). 201, wenn eine Regel entstand;
 * 200, wenn leere Modi sie entfernt haben.
 */

import type { NextRequest } from 'next/server';
import { actionErrorResponse, readJsonBody, respondWithAction } from '@/lib/actions/route';
import { setAuthorizationAction } from '@/lib/graph/authz/actions';

export async function POST(request: NextRequest) {
    try {
        return await respondWithAction(setAuthorizationAction, await readJsonBody(request), {
            statusFor: output => ((output as { authorization: unknown }).authorization ? 201 : 200),
        });
    } catch (error) {
        return actionErrorResponse(error);
    }
}
