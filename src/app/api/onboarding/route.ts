/**
 * Einführungsstrecke (GRAPH_CORE_SPEC §18, M14) — Route-Adapter der
 * Aktionen `onboarding_state` (GET), `onboarding_perform_step` (POST)
 * und `onboarding_undo_step` (DELETE `?step=`).
 */

import type { NextRequest } from 'next/server';
import { actionErrorResponse, readJsonBody, respondWithAction } from '@/lib/actions/route';
import { onboardingStateAction, performStepAction, undoStepAction } from '@/lib/graph/onboarding/actions';

export const dynamic = 'force-dynamic';

export async function GET() {
    return respondWithAction(onboardingStateAction, {});
}

export async function POST(request: NextRequest) {
    try {
        return await respondWithAction(performStepAction, await readJsonBody(request));
    } catch (error) {
        return actionErrorResponse(error);
    }
}

export async function DELETE(request: NextRequest) {
    const step = new URL(request.url).searchParams.get('step') ?? '';
    return respondWithAction(undoStepAction, { step });
}
