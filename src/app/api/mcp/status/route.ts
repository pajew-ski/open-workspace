/**
 * GET /api/mcp/status — Route-Adapter der Aktion `mcp_status` (SPEC §7.6,
 * M10). Geheimnisse verlassen diese Route nie — nur IDs, Scopes, Rechte.
 */

import { respondWithAction } from '@/lib/actions/route';
import { mcpStatus } from '@/lib/graph/mcp/actions.server';

export const dynamic = 'force-dynamic';

export async function GET() {
    return respondWithAction(mcpStatus, {});
}
