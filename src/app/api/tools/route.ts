/** Werkzeuge — Route-Adapter der Aktionen `tools_*` (ACTIONS_SPEC §3). */

import { NextResponse, type NextRequest } from 'next/server';
import { readJsonBody, respondWithAction, actionErrorResponse } from '@/lib/actions/route';
import { createToolAction, deleteToolAction, listTools } from '@/lib/tools/actions';

export async function GET() {
    return respondWithAction(listTools, {});
}

export async function POST(request: NextRequest) {
    try {
        return await respondWithAction(createToolAction, await readJsonBody(request));
    } catch (error) {
        return actionErrorResponse(error);
    }
}

export async function DELETE(request: NextRequest) {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
    return respondWithAction(deleteToolAction, { id });
}
