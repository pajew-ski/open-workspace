/**
 * DELETE /api/graph/access/groups/<id> — Route-Adapter der Aktion
 * `access_delete_group`.
 */

import type { NextRequest } from 'next/server';
import { respondWithAction } from '@/lib/actions/route';
import { deleteGroupAction } from '@/lib/graph/authz/actions';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    return respondWithAction(deleteGroupAction, { id });
}
