/**
 * Dokumente — Route-Adapter der Aktionen `workspace_list_docs` und
 * `workspace_create_doc` (ACTIONS_SPEC §3).
 */

import type { NextRequest } from 'next/server';
import { readJsonBody, respondWithAction, actionErrorResponse } from '@/lib/actions/route';
import { createDoc, listDocs } from '@/lib/graph/workspace/actions';

export async function GET() {
    return respondWithAction(listDocs, { limit: 500 });
}

export async function POST(request: NextRequest) {
    try {
        return await respondWithAction(createDoc, await readJsonBody(request), { status: 201 });
    } catch (error) {
        return actionErrorResponse(error);
    }
}
