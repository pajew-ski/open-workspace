/**
 * Erreichbarkeits-Probe eines föderierten Endpoints (SPEC §7.4, M11).
 *
 * POST /api/graph/federation/endpoints/[id]/probe
 *
 * Die Probe ist eine echte `ASK`-Query über den SSRF-geschützten Weg —
 * kein Ping, kein Vermuten. Ein nicht erreichbarer Endpoint wird in der
 * UI ehrlich als solcher markiert, samt Grund.
 */

import { NextResponse } from 'next/server';
import { getUserGraph } from '@/lib/graph/server/context';
import { getFederatedEndpoint } from '@/lib/graph/federation/registry';
import { probeEndpoint } from '@/lib/graph/federation/remote';

interface RouteContext {
    params: Promise<{ id: string }>;
}

export async function POST(_request: Request, context: RouteContext): Promise<Response> {
    const { id } = await context.params;
    try {
        const endpoint = await getFederatedEndpoint(await getUserGraph(), id);
        if (!endpoint) {
            return NextResponse.json({ error: `Endpoint "${id}" existiert nicht.` }, { status: 404 });
        }
        const probe = await probeEndpoint(endpoint.url);
        return NextResponse.json({ endpointId: endpoint.id, ...probe });
    } catch (error) {
        console.error('Federation Probe Error:', error);
        return NextResponse.json({ error: 'Probe konnte nicht ausgeführt werden.' }, { status: 500 });
    }
}
