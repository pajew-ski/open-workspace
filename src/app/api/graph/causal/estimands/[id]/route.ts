/**
 * Eine Frage entfernen (`ow:Estimand`, C4).
 *
 * DELETE /api/graph/causal/estimands/<id>
 *
 * Die Antworten verschwinden nicht mit dem Aufruf, sondern mit dem
 * nächsten Lauf: Der Inferenz-Graph wird vollständig ersetzt (Invariante
 * C4), und eine Frage, die es nicht mehr gibt, hinterlässt dabei nichts.
 * Deshalb sagt die Antwort das auch.
 */

import { NextResponse } from 'next/server';
import { getUserGraph } from '@/lib/graph/server/context';
import { persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import { deleteEstimand } from '@/lib/graph/causal/estimand';

type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
    const { id } = await context.params;
    try {
        const handle = await getUserGraph();
        const removed = await deleteEstimand(handle, id);
        if (!removed) {
            return NextResponse.json({ error: 'Frage nicht gefunden.' }, { status: 404 });
        }
        await persistServerGraphSnapshot();
        return NextResponse.json({
            deleted: true,
            message: 'Frage entfernt. Ihr Ergebnis verschwindet mit dem nächsten Lauf.',
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Frage konnte nicht entfernt werden.';
        const status = message.includes('Ungültige') ? 400 : 500;
        if (status === 500) console.error('Causal Estimand Delete Error:', error);
        return NextResponse.json({ error: message }, { status });
    }
}
