/** Aktivitätslog — Route-Adapter der Aktion `activity_list` (ACTIONS_SPEC §3). */

import type { NextRequest } from 'next/server';
import { respondWithAction } from '@/lib/actions/route';
import { listActivity } from '@/lib/app/actions';

export async function GET(request: NextRequest) {
    const limitParam = Number(new URL(request.url).searchParams.get('limit'));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 20;
    return respondWithAction(listActivity, { limit });
}
