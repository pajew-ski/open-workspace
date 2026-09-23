/**
 * DELETE /api/graph/access/spaces/<id> — Route-Adapter der Aktion
 * `access_delete_space`: Raum, Graph und seine Regeln.
 */

import type { NextRequest } from 'next/server';
import { respondWithAction } from '@/lib/actions/route';
import { deleteSpaceAction } from '@/lib/graph/authz/actions';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    return respondWithAction(deleteSpaceAction, { id });
}
