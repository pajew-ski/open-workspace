/**
 * GET /api/graph/views/<id>/resolve — Route-Adapter der Aktion
 * `graph_resolve_view` (Subgraph einer gespeicherten Query).
 */

import type { NextRequest } from 'next/server';
import { respondWithAction } from '@/lib/actions/route';
import { resolveView } from '@/lib/graph/views/actions.server';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    return respondWithAction(resolveView, { id });
}
