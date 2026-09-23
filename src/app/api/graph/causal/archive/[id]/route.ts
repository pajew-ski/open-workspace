/**
 * DELETE /api/graph/causal/archive/<id> — Route-Adapter der Aktion
 * `causal_delete_archive_entry` (docs/spec-widersprueche.md, Eintrag 3).
 */

import type { NextRequest } from 'next/server';
import { respondWithAction } from '@/lib/actions/route';
import { deleteArchiveEntryAction } from '@/lib/graph/causal/actions.server';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    return respondWithAction(deleteArchiveEntryAction, { id });
}
