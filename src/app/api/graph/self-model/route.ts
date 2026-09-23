/**
 * GET /api/graph/self-model — Route-Adapter der Aktion `graph_self_model`
 * (SPEC §18): per SPARQL aus graph/meta, nicht gepflegt.
 */

import { respondWithAction } from '@/lib/actions/route';
import { selfModel } from '@/lib/graph/meta/actions';

export const dynamic = 'force-dynamic';

export async function GET() {
    return respondWithAction(selfModel, {});
}
