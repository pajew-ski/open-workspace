/**
 * Ergebnis-als-Graph-Vorschau des SPARQL-Editors (GRAPH_CORE_SPEC §7.1, M2).
 *
 * POST /api/graph/views/preview { queryText } → { nodes, links, quadCount,
 * truncated } — dieselbe Auflösung wie gespeicherte Views (erlaubtes
 * Dataset, harte Kappung), nur ohne zu speichern. Nur graph-förmige
 * Queries (CONSTRUCT/DESCRIBE); alles andere beantwortet der
 * SPARQL-Endpoint selbst.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';
import { getServerGraph } from '@/lib/graph/server/instance';
import { resolveQueryTextAsGraph } from '@/lib/graph/views/registry';
import { createFederationResolver } from '@/lib/graph/federation/host.server';
import { summarizeFederation } from '@/lib/graph/federation/service';

const previewSchema = z.object({
    queryText: z.string().min(1).max(100_000),
});

export async function POST(request: NextRequest) {
    const parsed = await parseBody(previewSchema, request);
    if (!parsed.ok) return parsed.response;

    try {
        const handle = await getServerGraph();
        const federation = createFederationResolver();
        const resolved = await resolveQueryTextAsGraph(handle, parsed.data.queryText, {
            federation: federation.resolve,
        });
        const report = federation.report();
        return NextResponse.json(
            report.calls.length > 0 ? { ...resolved, federation: summarizeFederation(report) } : resolved,
        );
    } catch (error) {
        return NextResponse.json(
            { error: 'Query nicht als Graph auflösbar', details: error instanceof Error ? error.message : 'unknown' },
            { status: 400 },
        );
    }
}
