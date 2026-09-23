/**
 * Reasoning (GRAPH_CORE_SPEC §8) — Route-Adapter der Aktionen
 * `graph_reasoning_status` (GET) und `graph_reasoning_run` (POST).
 */

import { respondWithAction } from '@/lib/actions/route';
import { reasoningRun, reasoningState } from '@/lib/graph/reasoning/actions';

export async function GET() {
    return respondWithAction(reasoningState, {});
}

export async function POST() {
    return respondWithAction(reasoningRun, {});
}
