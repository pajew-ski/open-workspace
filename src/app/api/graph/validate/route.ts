/**
 * On-demand-SHACL-Validierung (GRAPH_CORE_SPEC §7.2, Stelle 3 — M7).
 *
 * POST /api/graph/validate — validiert die Wissens-Graphen gegen
 * graph/shapes und liefert den Befund als JSON. Body optional:
 * `{ "graphs": ["<iri>", …] }` beschränkt auf bestimmte Graphen;
 * nicht erlaubte (acl, presentation, inferred, vocab, shapes) werden
 * still verworfen — leeres Ergebnis statt Existenzbestätigung.
 * Berichtend, nie blockierend: Der Store wird nicht verändert.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';
import { getServerGraph } from '@/lib/graph/server/instance';
import { validateStoreGraphs } from '@/lib/graph/reasoning/run';

const validateSchema = z.object({
    graphs: z.array(z.string().max(2048)).max(100).optional(),
}).optional();

export async function POST(request: NextRequest) {
    let graphs: string[] | undefined;
    if ((request.headers.get('content-type') ?? '').includes('json')) {
        const parsed = await parseBody(validateSchema, request);
        if (!parsed.ok) return parsed.response;
        graphs = parsed.data?.graphs;
    }
    try {
        const handle = await getServerGraph();
        const report = await validateStoreGraphs(handle, graphs);
        return NextResponse.json({ report });
    } catch (error) {
        return NextResponse.json(
            { error: 'Validierung nicht ausführbar', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 },
        );
    }
}
