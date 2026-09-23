/**
 * POST /api/graph/observations/capture — Route-Adapter der Aktion
 * `observations_capture`. Ein Lauf, in dem jede Größe scheiterte, ist
 * kein Erfolg: 502 statt eines versteckten 200.
 */

import type { NextRequest } from 'next/server';
import { actionErrorResponse, readJsonBody, respondWithAction } from '@/lib/actions/route';
import { captureAction } from '@/lib/graph/observations/actions.server';

export async function POST(request: NextRequest) {
    try {
        return await respondWithAction(captureAction, await readJsonBody(request), {
            statusFor: output => {
                const results = (output as { results: Array<{ status: string }> }).results;
                const allFailed = results.length > 0 && results.every(result => result.status === 'failed');
                return allFailed ? 502 : 200;
            },
        });
    } catch (error) {
        return actionErrorResponse(error);
    }
}
