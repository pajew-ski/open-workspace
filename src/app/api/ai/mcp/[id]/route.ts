import { NextRequest, NextResponse } from 'next/server';
import { parseBody, mcpOpSchema } from '@/lib/api/validation';
import { resolveMcpServerAuth } from '@/lib/ai/store.server';
import { callMcpTool, getMcpPromptText, listMcpPrompts, listMcpTools, probeMcp } from '@/lib/ai/mcp/client';
import { invalidateMcpToolCache } from '@/lib/ai/server/deps';

/**
 * Server relay for MCP operations. The browser uses this when a direct
 * connection is not possible (CORS-blocked server, auth header stored
 * server-side) — configured servers only, never arbitrary URLs (SSRF).
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
    const { id } = await context.params;
    const parsed = await parseBody(mcpOpSchema, request);
    if (!parsed.ok) return parsed.response;

    const resolved = await resolveMcpServerAuth(id);
    if (!resolved) {
        return NextResponse.json({ error: 'MCP-Server nicht gefunden' }, { status: 404 });
    }
    if (resolved.server.connectionMode === 'browser') {
        return NextResponse.json({ error: 'Dieser MCP-Server ist auf Browser-Verbindung eingestellt.' }, { status: 400 });
    }
    const endpoint = {
        url: resolved.server.url,
        transport: resolved.server.transport,
        headers: resolved.headers,
    };

    try {
        switch (parsed.data.op) {
            case 'probe': {
                invalidateMcpToolCache(id);
                return NextResponse.json(await probeMcp(endpoint));
            }
            case 'listTools':
                return NextResponse.json({ tools: await listMcpTools(endpoint) });
            case 'callTool':
                return NextResponse.json(await callMcpTool(endpoint, parsed.data.name, parsed.data.args));
            case 'listPrompts':
                return NextResponse.json({ prompts: await listMcpPrompts(endpoint) });
            case 'getPrompt':
                return NextResponse.json({ text: await getMcpPromptText(endpoint, parsed.data.name, parsed.data.args) });
        }
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'MCP-Operation fehlgeschlagen' },
            { status: 502 }
        );
    }
}
