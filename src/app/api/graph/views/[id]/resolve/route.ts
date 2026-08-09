/**
 * Auflösung einer Query-View zum Live-Subgraphen (GRAPH_CORE_SPEC §9, M5).
 * Läuft über dasselbe erlaubte Dataset wie jede SPARQL-Anfrage
 * (resolveDataset) — presentation/inferred/acl sind draußen.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerGraph } from '@/lib/graph/server/instance';
import { resolveQueryView } from '@/lib/graph/views/registry';

interface RouteContext {
    params: Promise<{ id: string }>;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;

export async function GET(_request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    if (!ID_PATTERN.test(id)) {
        return NextResponse.json({ error: 'Ungültige View-ID' }, { status: 400 });
    }
    try {
        const handle = await getServerGraph();
        const resolved = await resolveQueryView(handle, id);
        return NextResponse.json(resolved);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown';
        const status = message.includes('nicht registriert') ? 404 : 400;
        return NextResponse.json({ error: 'View nicht auflösbar', details: message }, { status });
    }
}
