/**
 * Ein Retrieval-Profil — Route-Adapter der Aktionen
 * `graph_get_retrieval_profile` und `graph_delete_retrieval_profile`.
 */

import type { NextRequest } from 'next/server';
import { respondWithAction } from '@/lib/actions/route';
import { deleteProfile, getProfile } from '@/lib/graph/search/actions';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    return respondWithAction(getProfile, { id });
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
    const { id } = await params;
    return respondWithAction(deleteProfile, { id });
}
