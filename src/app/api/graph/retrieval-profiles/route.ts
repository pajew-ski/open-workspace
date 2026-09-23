/**
 * Retrieval-Profile (GRAPH_CORE_SPEC §7.5, M8) — Route-Adapter der
 * Aktionen `graph_list_retrieval_profiles` und
 * `graph_create_retrieval_profile`.
 */

import type { NextRequest } from 'next/server';
import { actionErrorResponse, readJsonBody, respondWithAction } from '@/lib/actions/route';
import { createProfile, listProfiles } from '@/lib/graph/search/actions';

export async function GET() {
    return respondWithAction(listProfiles, {});
}

export async function POST(request: NextRequest) {
    try {
        return await respondWithAction(createProfile, await readJsonBody(request), { status: 201 });
    } catch (error) {
        return actionErrorResponse(error);
    }
}
