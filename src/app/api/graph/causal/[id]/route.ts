/**
 * Ein Kausalmodell (CAUSAL_LAYER_SPEC §5, C0).
 *
 * GET    /api/graph/causal/<id> → Modell samt Variablen und Kanten
 * DELETE /api/graph/causal/<id> → Modell entfernen (der Named Graph IST
 *                                 die Modellgrenze, also fällt alles
 *                                 zusammen mit ihm)
 *
 * Der Bestand an Beobachtungen bleibt unberührt: Messreihen gehören
 * keinem Modell, sondern der Installation (Invariante C3). Ein gelöschtes
 * Modell ist eine verworfene Annahme, kein verworfener Datenbestand.
 */

import { NextResponse } from 'next/server';
import { getUserGraph } from '@/lib/graph/server/context';
import { persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import { deleteCausalModel, readCausalModel } from '@/lib/graph/causal/model';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
    const { id } = await context.params;
    try {
        const handle = await getUserGraph();
        const model = await readCausalModel(handle, { modelId: id, graph: handle.iri.causalGraph(id) });
        if (!model) {
            return NextResponse.json({ error: 'Kausalmodell nicht gefunden.' }, { status: 404 });
        }
        return NextResponse.json({ model });
    } catch (error) {
        console.error('Causal Model Read Error:', error);
        return NextResponse.json({ error: 'Kausalmodell konnte nicht gelesen werden.' }, { status: 500 });
    }
}

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
    const { id } = await context.params;
    try {
        const handle = await getUserGraph();
        const removed = await deleteCausalModel(handle, id);
        if (!removed) {
            return NextResponse.json({ error: 'Kausalmodell nicht gefunden.' }, { status: 404 });
        }
        await persistServerGraphSnapshot();
        return NextResponse.json({
            deleted: true,
            message: 'Modell entfernt. Erfasste Beobachtungen bleiben erhalten.',
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Kausalmodell konnte nicht entfernt werden.';
        const status = message.includes('Ungültige') ? 400 : 500;
        if (status === 500) console.error('Causal Model Delete Error:', error);
        return NextResponse.json({ error: message }, { status });
    }
}
