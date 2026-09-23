/**
 * GET /api/graph — abwärtskompatible schema.org-`@graph`-Ansicht.
 * Route-Adapter der Aktion `graph_overview` (ACTIONS_SPEC §3).
 */

import { respondWithAction } from '@/lib/actions/route';
import { graphOverview } from '@/lib/graph/meta/actions';

export async function GET() {
    return respondWithAction(graphOverview, {});
}
