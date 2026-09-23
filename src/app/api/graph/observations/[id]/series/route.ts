/**
 * GET /api/graph/observations/<id>/series?from=<ISO>&to=<ISO>&limit=<n> —
 * Route-Adapter der Aktion `observations_series`. Ein unbrauchbares
 * `limit` fällt auf den Default der Aktion zurück, ein zu großes wird
 * gekappt (SPEC §7.5).
 */

import type { NextRequest } from 'next/server';
import { respondWithAction } from '@/lib/actions/route';
import { readSeries } from '@/lib/graph/observations/actions.server';

const MAX_POINTS = 50_000;

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    const query = new URL(request.url).searchParams;
    const from = query.get('from');
    const to = query.get('to');
    const requestedLimit = Number(query.get('limit'));
    const limit = Number.isFinite(requestedLimit) && requestedLimit >= 1
        ? Math.min(Math.floor(requestedLimit), MAX_POINTS)
        : undefined;
    return respondWithAction(readSeries, {
        id,
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(limit !== undefined ? { limit } : {}),
    });
}
