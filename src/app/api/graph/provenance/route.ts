/**
 * GET /api/graph/provenance — Route-Adapter der Aktion `graph_provenance`
 * (SPEC §11: Aussagen je Graph nach Herkunft).
 */

import { respondWithAction } from '@/lib/actions/route';
import { provenance } from '@/lib/graph/meta/actions';

export const dynamic = 'force-dynamic';

export async function GET() {
    return respondWithAction(provenance, {});
}
