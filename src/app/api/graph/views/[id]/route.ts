/**
 * Eine gespeicherte Query — Route-Adapter der Aktionen `graph_get_view`
 * und `graph_delete_view`.
 */

import type { NextRequest } from 'next/server';
import { respondWithAction } from '@/lib/actions/route';
import { deleteView, getView } from '@/lib/graph/views/actions.server';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    return respondWithAction(getView, { id });
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    return respondWithAction(deleteView, { id });
}
