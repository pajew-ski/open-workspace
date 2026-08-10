/**
 * Freigabe zurücknehmen (SPEC §17.2, M13). Verlangt `control` auf dem
 * Graphen, für den die Regel gilt — nicht auf der Regel selbst.
 */

import { NextResponse } from 'next/server';
import { getRequestGraph } from '@/lib/graph/server/context';
import { persistAclSnapshot } from '@/lib/graph/server/instance';
import { deleteAuthorization, listAuthorizations } from '@/lib/graph/authz/acl-graph';

interface RouteContext {
    params: Promise<{ id: string }>;
}

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
    const { id } = await context.params;
    try {
        const { store, iri, grant } = await getRequestGraph();
        const handle = { store, iri };
        const rule = (await listAuthorizations(handle)).find(entry => entry.id === id);
        // Unbekannte Regel und fremde Regel sehen identisch aus.
        if (!rule || !(grant.controlGraphs ?? []).includes(rule.graph)) {
            return NextResponse.json({ error: 'Regel nicht gefunden.' }, { status: 404 });
        }
        await deleteAuthorization(handle, id);
        await persistAclSnapshot();
        return NextResponse.json({ deleted: id });
    } catch (error) {
        return NextResponse.json(
            { error: 'Freigabe nicht entfernt', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 },
        );
    }
}
