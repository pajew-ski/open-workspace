/**
 * Einen Chronik-Eintrag verwerfen (docs/spec-widersprueche.md, Eintrag 3).
 *
 * DELETE /api/graph/causal/archive/<id>
 *
 * Die Chronik hält fest, was ein Lauf gesagt hat — nicht, dass der Lauf
 * hätte stattfinden sollen. Ein Lauf auf falsch erfassten Daten oder auf
 * einem Modell im Bau ist keine Geschichte, sondern Störung. Wer ihn
 * nicht entfernen kann, hört auf, in die Chronik zu schauen.
 *
 * Verworfen wird immer ein **ganzer** Eintrag, ausdrücklich und einzeln.
 * Einen Eintrag zu ändern gibt es nicht: Dann stünde in der Chronik
 * etwas, das so nie gerechnet wurde.
 */

import { NextResponse } from 'next/server';
import { getUserGraph } from '@/lib/graph/server/context';
import { persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import { deleteArchiveEntry } from '@/lib/graph/causal/archive';

type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
    const { id } = await context.params;
    try {
        const handle = await getUserGraph();
        // Die Adresse wird aus der ID gebildet und nicht vom Aufrufer
        // übernommen: Sonst könnte ein Aufruf auf einen beliebigen Knoten
        // im eigenen Namensraum zeigen.
        const entryIri = handle.iri.entity('study-record', id);
        const removed = await deleteArchiveEntry(handle, entryIri);
        if (!removed) {
            return NextResponse.json({ error: 'Chronik-Eintrag nicht gefunden.' }, { status: 404 });
        }
        await persistServerGraphSnapshot();
        return NextResponse.json({
            deleted: true,
            message: 'Eintrag verworfen. Der nächste Lauf hält wieder fest, was sich ändert.',
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Eintrag konnte nicht verworfen werden.';
        console.error('Causal Archive Delete Error:', error);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
