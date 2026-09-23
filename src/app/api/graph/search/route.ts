/**
 * Volltext-/Vektorsuche über den Graphen (SPEC §7.7, M8) — Route-Adapter
 * der Aktion `graph_search` (ACTIONS_SPEC §3, A2). Dieselbe Definition
 * trägt das MCP-Werkzeug und den Tool-Loop des Assistenten.
 *
 * GET /api/graph/search?q=…&limit=…&vector=1
 */

import { respondWithAction } from '@/lib/actions/route';
import { graphSearch } from '@/lib/graph/mcp/actions';

export async function GET(request: Request): Promise<Response> {
    const { searchParams } = new URL(request.url);
    const limitRaw = Number.parseInt(searchParams.get('limit') ?? '20', 10);
    return respondWithAction(graphSearch, {
        query: searchParams.get('q')?.trim() ?? '',
        limit: Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20,
        vector: searchParams.get('vector') === '1',
    });
}
