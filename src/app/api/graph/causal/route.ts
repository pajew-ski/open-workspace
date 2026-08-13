/**
 * Kausalmodelle (CAUSAL_LAYER_SPEC §5, Meilenstein C0).
 *
 * GET  /api/graph/causal → Modelle mit Variablen und Kanten, Hypothesen,
 *                          SHACL-Befunde der Kausal-Graphen
 * POST /api/graph/causal → ein leeres Modell anlegen (Named Graph +
 *                          Modell-Knoten). Die Struktur schreibt der
 *                          Mensch per SPARQL — C0 liefert die Ansicht,
 *                          keinen DAG-Editor.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getRequestGraph } from '@/lib/graph/server/context';
import { persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import {
    causalGraphsOf,
    createCausalModel,
    listCausalHypotheses,
    listCausalModels,
} from '@/lib/graph/causal/model';
import { validateStoreGraphs } from '@/lib/graph/reasoning/run';

const createSchema = z.object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
}).strict();

export async function GET(): Promise<Response> {
    try {
        const { store, iri, grant } = await getRequestGraph();
        const handle = { store, iri };
        const allowedGraphs = grant.readableGraphs;
        const models = await listCausalModels(handle, { allowedGraphs });
        const hypotheses = await listCausalHypotheses(handle, { allowedGraphs });
        // Die Shapes aus ontology/shapes/causal.ttl sind nur dann etwas
        // wert, wenn ihre Befunde auch ankommen — deshalb laufen sie bei
        // jedem Lesen über die Kausal-Graphen (§7.2 Stelle 3). Blockieren
        // tun sie nichts; ein Modell mit Mängeln bleibt sichtbar.
        const hypothesesGraph = iri.graph('causal-hypotheses');
        const existing = (await store.graphs()).map(g => g.value);
        // Auch hier klammert der Grant: validiert wird nur, was der
        // Aufrufer ohnehin lesen darf — ein Bericht über einen gesperrten
        // Graphen wäre eine Existenzbestätigung (§17.3).
        const targets = [
            ...causalGraphsOf(iri, existing).map(ref => ref.graph),
            ...existing.filter(graph => graph === hypothesesGraph),
        ].filter(graph => allowedGraphs.includes(graph));
        // Ohne Ziel wird NICHT validiert: eine leere Liste hieße im
        // Validierer „alles Erlaubte", und die ganze Wissensbasis wegen
        // einer noch leeren Kausal-Seite zu prüfen, wäre Verschwendung.
        const validation = targets.length > 0
            ? await validateStoreGraphs(handle, [...new Set(targets)])
            : { conforms: true, graphs: [] as string[], results: [] };
        return NextResponse.json({
            models,
            hypotheses,
            hypothesesGraph,
            validation: {
                conforms: validation.conforms,
                graphs: validation.graphs,
                results: validation.results,
            },
        });
    } catch (error) {
        console.error('Causal Models Error:', error);
        return NextResponse.json({ error: 'Kausalmodelle konnten nicht gelesen werden.' }, { status: 500 });
    }
}

export async function POST(request: Request): Promise<Response> {
    let parsed: z.infer<typeof createSchema>;
    try {
        parsed = createSchema.parse(await request.json());
    } catch (error) {
        const message = error instanceof z.ZodError
            ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
            : 'Ungültiger Request-Body.';
        return NextResponse.json({ error: message }, { status: 400 });
    }

    try {
        const { store, iri } = await getRequestGraph();
        const model = await createCausalModel({ store, iri }, parsed);
        await persistServerGraphSnapshot();
        return NextResponse.json({ model }, { status: 201 });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Kausalmodell konnte nicht angelegt werden.';
        const status = message.includes('existiert bereits') ? 409
            : message.includes('Ungültige') ? 400
            : 500;
        if (status === 500) console.error('Causal Model Create Error:', error);
        return NextResponse.json({ error: message }, { status });
    }
}
