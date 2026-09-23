/** Verbindungen — Route-Adapter der Aktionen `connections_*` (ACTIONS_SPEC §3). */

import { NextResponse, type NextRequest } from 'next/server';
import { readJsonBody, respondWithAction, actionErrorResponse } from '@/lib/actions/route';
import {
    createConnectionAction,
    deleteConnectionAction,
    listConnections,
    updateConnectionAction,
} from '@/lib/connections/actions';

export async function GET() {
    return respondWithAction(listConnections, {});
}

export async function POST(request: NextRequest) {
    try {
        return await respondWithAction(createConnectionAction, await readJsonBody(request));
    } catch (error) {
        return actionErrorResponse(error);
    }
}

export async function PUT(request: NextRequest) {
    try {
        return await respondWithAction(updateConnectionAction, await readJsonBody(request));
    } catch (error) {
        return actionErrorResponse(error);
    }
}

export async function DELETE(request: NextRequest) {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
    return respondWithAction(deleteConnectionAction, { id });
}
