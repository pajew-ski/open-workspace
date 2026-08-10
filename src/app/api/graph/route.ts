/**
 * GET /api/graph — abwärtskompatible schema.org-`@graph`-Ansicht.
 *
 * Seit dem Graph-Core-Umbau (SPEC §12.3) wird die Antwort per SPARQL aus
 * dem RDF-Store generiert, nicht mehr ad hoc aus den Dateien. Die
 * Präsentations-Properties `color` und `val` sind entfernt — die Graph-UI
 * berechnet sie clientseitig aus dem Typ.
 */

import { NextResponse } from 'next/server';
import { getRequestGraph } from '@/lib/graph/server/context';
import { buildLegacyGraphView } from '@/lib/graph/projection/schema-org';

export async function GET() {
    try {
        const { store, iri, grant } = await getRequestGraph();
        const view = await buildLegacyGraphView(store, iri, { allowedGraphs: grant.readableGraphs });
        return NextResponse.json(view);
    } catch (error) {
        console.error('Graph API Error:', error);
        return NextResponse.json({ error: 'Failed to generate graph' }, { status: 500 });
    }
}
