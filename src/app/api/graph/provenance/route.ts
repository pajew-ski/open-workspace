/**
 * Herkunft der Aussagen (GRAPH_CORE_SPEC §11/§18, M14).
 *
 * `GET /api/graph/provenance` zählt je Named Graph des anfragenden
 * Nutzers, wie viele Aussagen dort stehen, und ordnet sie den drei
 * Herkünften zu: nativ (eigene Graphen), importiert (Connector-Graphen)
 * und inferiert (Reasoner-Graphen). Das ist die Datenlage, nicht eine
 * Anzeige-Konvention — der Graph-Explorer und die Einführungsstrecke
 * zeigen dieselben Zahlen aus derselben Quelle.
 */

import { NextResponse } from 'next/server';
import { getRequestGraph } from '@/lib/graph/server/context';
import { provenanceSummary } from '@/lib/graph/provenance';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
    try {
        const { store, iri, grant } = await getRequestGraph();
        const summary = await provenanceSummary({ store, iri }, { allowedGraphs: grant.readableGraphs });
        return NextResponse.json(summary);
    } catch (error) {
        return NextResponse.json(
            { error: 'Herkunft nicht ermittelbar', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 },
        );
    }
}
