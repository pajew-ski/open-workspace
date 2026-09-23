/**
 * POST /api/graph/observations/<id>/backfill — Route-Adapter der Aktion
 * `observations_backfill`. Statuscodes: 409, wenn die Quelle diese Größe
 * grundsätzlich nicht liefern kann (eine Auskunft, kein Serverfehler),
 * 502 bei gescheitertem Abruf.
 */

import type { NextRequest } from 'next/server';
import { actionErrorResponse, readJsonBody, respondWithAction } from '@/lib/actions/route';
import { backfillAction } from '@/lib/graph/observations/actions.server';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    try {
        const body = await readJsonBody(request);
        return await respondWithAction(backfillAction, { ...(body as object), id }, {
            statusFor: output => {
                const status = (output as { status: string }).status;
                return status === 'refused' ? 409 : status === 'failed' ? 502 : 200;
            },
        });
    } catch (error) {
        return actionErrorResponse(error);
    }
}
