/** Ein MCP-Server — Route-Adapter der Aktionen `ai_update_mcp_server` und `ai_delete_mcp_server` (ACTIONS_SPEC §3). */

import type { NextRequest } from 'next/server';
import { readJsonBody, respondWithAction, actionErrorResponse } from '@/lib/actions/route';
import { aiDeleteMcpServer, aiUpdateMcpServer } from '@/lib/ai/actions.server';

interface RouteContext {
    params: Promise<{ id: string }>;
}

export async function PUT(request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    try {
        const body = await readJsonBody(request);
        return await respondWithAction(aiUpdateMcpServer, { ...(body as object), id });
    } catch (error) {
        return actionErrorResponse(error);
    }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    return respondWithAction(aiDeleteMcpServer, { id });
}
