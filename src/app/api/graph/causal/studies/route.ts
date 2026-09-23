/**
 * Studien: der Lauf und sein Ergebnis (CAUSAL_LAYER_SPEC §13, C4) —
 * Route-Adapter der Aktionen `causal_list_studies` und `causal_run_studies`.
 */

import { respondWithAction } from '@/lib/actions/route';
import { listStudies, runStudies } from '@/lib/graph/causal/actions.server';

/** Bootstrap und Refutation gehen mehrfach über dieselben Daten. */
export const maxDuration = 120;

export async function GET() {
    return respondWithAction(listStudies, {});
}

export async function POST() {
    return respondWithAction(runStudies, {});
}
