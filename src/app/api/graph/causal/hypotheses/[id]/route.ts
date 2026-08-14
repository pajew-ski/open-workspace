/**
 * Einen Vorschlag übernehmen oder verwerfen
 * (CAUSAL_LAYER_SPEC §8, Meilenstein C6).
 *
 * POST   /api/graph/causal/hypotheses/<id> → ins Modell übernehmen
 * DELETE /api/graph/causal/hypotheses/<id> → aus der Liste verwerfen
 *
 * **Hier hängt die Abnahme von C6.** Das Übernehmen ist die einzige
 * Brücke vom Hypothesen-Graphen in die gesetzte Struktur — und damit in
 * den Studien-Pfad. Ein von den Filtern verworfener Vorschlag wird
 * deshalb serverseitig abgelehnt, nicht bloß in der Oberfläche
 * ausgegraut: Eine Regel, die nur im Client steht, ist keine.
 *
 * Wer einen verworfenen Vorschlag trotzdem für richtig hält, zieht die
 * Kante im DAG-Editor selbst. Sie trägt dann `asserted` — die Herkunft
 * eines Menschen, der sie verantwortet, statt der einer Maschine, die
 * durchgefallen ist (Invariante C2).
 */

import { NextResponse } from 'next/server';
import { getRequestGraph } from '@/lib/graph/server/context';
import { persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import { adoptHypothesis, discardHypothesis } from '@/lib/graph/causal/hypothesis';
import { CausalEditError } from '@/lib/graph/causal/edit';
import { ShaclViolationError } from '@/lib/graph/reasoning/shacl';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext): Promise<Response> {
    const { id } = await context.params;
    try {
        const { store, iri, identity } = await getRequestGraph();
        const result = await adoptHypothesis({ store, iri }, id, {
            ...(identity.userId ? { actor: iri.principal('user', identity.userId) } : {}),
        });
        await persistServerGraphSnapshot();
        return NextResponse.json(result);
    } catch (error) {
        if (error instanceof CausalEditError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        if (error instanceof ShaclViolationError) {
            return NextResponse.json(
                { error: error.message, details: error.violations.map(violation => violation.message) },
                { status: 422 },
            );
        }
        console.error('Causal Hypothesis Adopt Error:', error);
        const message = error instanceof Error ? error.message : 'Vorschlag konnte nicht übernommen werden.';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
    const { id } = await context.params;
    try {
        const { store, iri } = await getRequestGraph();
        const removed = await discardHypothesis({ store, iri }, id);
        if (!removed) {
            return NextResponse.json({ error: 'Diesen Vorschlag gibt es nicht.' }, { status: 404 });
        }
        await persistServerGraphSnapshot();
        return NextResponse.json({
            deleted: true,
            message: 'Vorschlag verworfen. Der nächste Lauf derselben Quelle nennt ihn wieder — '
                + 'aufgeräumt wird eine Arbeitsliste, keine Meinung.',
        });
    } catch (error) {
        console.error('Causal Hypothesis Delete Error:', error);
        const message = error instanceof Error ? error.message : 'Vorschlag konnte nicht verworfen werden.';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
