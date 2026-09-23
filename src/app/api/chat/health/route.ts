/** Inferenz-Status — Route-Adapter der Aktion `ai_health` (ACTIONS_SPEC §3). */

import { respondWithAction } from '@/lib/actions/route';
import { aiHealth } from '@/lib/ai/actions.server';

export async function GET() {
    return respondWithAction(aiHealth, {});
}
