/**
 * Selbstmodell der Installation (GRAPH_CORE_SPEC §18, M14).
 *
 * `GET /api/graph/self-model` beantwortet „was ist dieses System und
 * welche Module hat es" per SPARQL aus `graph/meta` — dieselbe Abfrage,
 * die der Assistent für seinen Systemkontext nutzt. Die Route erzeugt
 * nichts: Was hier steht, hat der Start aus dem Code generiert.
 *
 * Das Dataset kommt aus dem Grant der Anfrage (§17.3): Ohne Leserecht auf
 * `graph/meta` ist die Antwort leer, nicht verboten — eine Fehlermeldung
 * wäre eine Existenzbestätigung.
 */

import { NextResponse } from 'next/server';
import { getRequestGraph } from '@/lib/graph/server/context';
import { readSelfModel } from '@/lib/graph/meta/self-model-query';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
    try {
        const { store, iri, grant } = await getRequestGraph();
        const view = await readSelfModel(store, iri, { allowedGraphs: grant.readableGraphs });
        return NextResponse.json(view);
    } catch (error) {
        return NextResponse.json(
            { error: 'Selbstmodell nicht ladbar', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 },
        );
    }
}
