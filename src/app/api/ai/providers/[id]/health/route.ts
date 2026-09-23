/**
 * Server-seitige Provider-Probe — Route-Adapter der Aktion
 * `ai_probe_provider` (ACTIONS_SPEC §3). Der Client ruft sie, wenn der
 * direkte Browser-Weg scheitert — zusammen beantworten sie die
 * Routing-Frage „wer erreicht diesen Endpunkt?".
 */

import type { NextRequest } from 'next/server';
import { respondWithAction } from '@/lib/actions/route';
import { aiProbeProvider } from '@/lib/ai/actions.server';

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
    const { id } = await context.params;
    return respondWithAction(aiProbeProvider, { id });
}
