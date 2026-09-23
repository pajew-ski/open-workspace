/**
 * Client-sichere Sicht der AI-Konfiguration — Route-Adapter der Aktion
 * `ai_config` (ACTIONS_SPEC §3). Dient dem Client zugleich als
 * Backend-Verfügbarkeits-Probe.
 */

import { respondWithAction } from '@/lib/actions/route';
import { aiConfig } from '@/lib/ai/actions.server';

export async function GET() {
    return respondWithAction(aiConfig, {});
}
