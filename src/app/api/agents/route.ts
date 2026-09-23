/** Agenten — Route-Adapter der Aktionen `agents_*` (ACTIONS_SPEC §3). */

import { NextResponse, type NextRequest } from 'next/server';
import { readJsonBody, respondWithAction, actionErrorResponse } from '@/lib/actions/route';
import { createAgentAction, deleteAgentAction, listAgents, updateAgentAction } from '@/lib/agents/actions';

export async function GET() {
    return respondWithAction(listAgents, {});
}

export async function POST(request: NextRequest) {
    try {
        return await respondWithAction(createAgentAction, await readJsonBody(request));
    } catch (error) {
        return actionErrorResponse(error);
    }
}

export async function PUT(request: NextRequest) {
    try {
        return await respondWithAction(updateAgentAction, await readJsonBody(request));
    } catch (error) {
        return actionErrorResponse(error);
    }
}

export async function DELETE(request: NextRequest) {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
    return respondWithAction(deleteAgentAction, { id });
}
