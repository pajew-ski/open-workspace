/**
 * MCP-Server-Endpoint (SPEC §7.6, M10).
 *
 * `POST|GET|DELETE /api/mcp` — Streamable HTTP nach MCP-Spezifikation.
 * Externe Agenten (Claude Desktop, ein zweiter Workspace, jeder
 * MCP-Client) retrieven hier auf dem Graphen, ohne SPARQL zu sprechen.
 *
 * Diese Datei ist reine Transport-Hülle: Authentifizierung, Sitzungen,
 * Rate-Limits und die Werkzeuge liegen in `src/lib/graph/mcp/`, die
 * Serverbindungen in `mcp/host.server.ts`.
 */

import { getMcpHost } from '@/lib/graph/mcp/host.server';

export const dynamic = 'force-dynamic';

async function handle(request: Request): Promise<Response> {
    try {
        return await getMcpHost().handle(request);
    } catch (error) {
        console.error('MCP Endpoint Error:', error);
        return new Response(
            JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Interner Fehler im MCP-Server.' }, id: null }),
            { status: 500, headers: { 'Content-Type': 'application/json' } },
        );
    }
}

export async function POST(request: Request): Promise<Response> {
    return handle(request);
}

export async function GET(request: Request): Promise<Response> {
    return handle(request);
}

export async function DELETE(request: Request): Promise<Response> {
    return handle(request);
}
