/**
 * Status des MCP-Servers (SPEC §7.6, M10) — Lesemodell für die UI.
 *
 * `GET /api/mcp/status` beantwortet genau die Fragen, die man vor dem
 * Anschließen eines externen Clients hat: Ist der Endpoint in dieser
 * Runtime verfügbar? Sind Tokens konfiguriert (und fehlerfrei)? Welche
 * Graphen darf welches Token lesen, welche Werkzeuge sieht es?
 *
 * Geheimnisse verlassen diese Route nie — nur IDs, Scopes und Rechte.
 */

import { NextResponse } from 'next/server';
import { getServerGraph } from '@/lib/graph/server/instance';
import { getMcpHost } from '@/lib/graph/mcp/host.server';
import { grantForToken, mcpTokensFromEnv, MCP_TOKENS_ENV } from '@/lib/graph/mcp/tokens';
import { toolsForGrant } from '@/lib/graph/mcp/server';
import { createNodeRuntimeAdapter } from '@/lib/platform/runtime/server';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
    const available = createNodeRuntimeAdapter().capabilities.mcpServer;
    const config = mcpTokensFromEnv();
    try {
        const handle = available && config.tokens.length > 0 ? await getServerGraph() : null;
        const existing = handle ? (await handle.store.graphs()).map(g => g.value) : [];
        const tokens = await Promise.all(config.tokens.map(async token => {
            const resolved = handle
                ? await grantForToken(token, handle, existing)
                : null;
            return {
                id: token.id,
                label: token.label ?? null,
                user: token.user,
                scopes: token.scopes ?? null,
                sparql: token.sparql,
                write: Boolean(resolved?.grant.writableGraph),
                writeScope: token.writeScope ?? null,
                rateLimitPerMinute: token.rateLimitPerMinute,
                readableGraphs: resolved?.grant.readableGraphs ?? [],
                tools: resolved ? toolsForGrant(resolved.grant) : [],
                ...(resolved?.writeScopeError ? { warning: resolved.writeScopeError } : {}),
            };
        }));
        return NextResponse.json({
            available,
            configured: config.tokens.length > 0,
            endpoint: '/api/mcp',
            envVar: MCP_TOKENS_ENV,
            errors: config.errors,
            sessions: available ? getMcpHost().sessionCount : 0,
            tokens,
        });
    } catch (error) {
        console.error('MCP Status Error:', error);
        return NextResponse.json({ error: 'MCP-Status nicht ermittelbar.' }, { status: 500 });
    }
}
