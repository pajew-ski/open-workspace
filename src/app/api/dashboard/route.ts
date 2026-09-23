/**
 * Übersichtsseite — Route-Adapter der Aktionen `dashboard_*` und
 * `activity_list` (ACTIONS_SPEC §3). `?action=stats|activities` wählt.
 */

import type { NextRequest } from 'next/server';
import { readJsonBody, respondWithAction, actionErrorResponse } from '@/lib/actions/route';
import { dashboardStats, getDashboardLayout, listActivity, saveDashboardLayout } from '@/lib/app/actions';

export async function GET(request: NextRequest) {
    const action = new URL(request.url).searchParams.get('action');
    if (action === 'stats') return respondWithAction(dashboardStats, {});
    if (action === 'activities') return respondWithAction(listActivity, { limit: 50 });
    return respondWithAction(getDashboardLayout, {});
}

export async function POST(request: NextRequest) {
    try {
        return await respondWithAction(saveDashboardLayout, await readJsonBody(request));
    } catch (error) {
        return actionErrorResponse(error);
    }
}
