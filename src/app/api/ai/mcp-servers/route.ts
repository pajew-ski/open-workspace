/** MCP-Server anlegen — Route-Adapter der Aktion `ai_create_mcp_server` (ACTIONS_SPEC §3). */

import type { NextRequest } from 'next/server';
import { readJsonBody, respondWithAction, actionErrorResponse } from '@/lib/actions/route';
import { aiCreateMcpServer } from '@/lib/ai/actions.server';

export async function POST(request: NextRequest) {
    try {
        return await respondWithAction(aiCreateMcpServer, await readJsonBody(request), { status: 201 });
    } catch (error) {
        return actionErrorResponse(error);
    }
}
