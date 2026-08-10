/**
 * Gruppe löschen (SPEC §17.1, M13). Bestehende Regeln auf die Gruppe
 * bleiben stehen und laufen ins Leere — sie zeigen auf einen Prinzipal,
 * den es nicht mehr gibt, und geben damit niemandem Rechte. Sie
 * stillschweigend mitzulöschen würde Freigaben ändern, die niemand
 * angefasst hat.
 */

import { NextResponse } from 'next/server';
import { getRequestGraph } from '@/lib/graph/server/context';
import { persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import { deleteGroup } from '@/lib/graph/authz/principals';

interface RouteContext {
    params: Promise<{ id: string }>;
}

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
    const { id } = await context.params;
    try {
        const { store, iri, grant } = await getRequestGraph();
        if (!(grant.controlGraphs ?? []).includes(iri.sharedGraph('meta'))) {
            return NextResponse.json({ error: 'Gruppe nicht gefunden.' }, { status: 404 });
        }
        const removed = await deleteGroup({ store, iri }, id);
        if (!removed) return NextResponse.json({ error: 'Gruppe nicht gefunden.' }, { status: 404 });
        await persistServerGraphSnapshot();
        return NextResponse.json({ deleted: id });
    } catch (error) {
        return NextResponse.json(
            { error: 'Gruppe nicht gelöscht', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 },
        );
    }
}
