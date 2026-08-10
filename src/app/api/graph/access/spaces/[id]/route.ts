/**
 * Raum auflösen (SPEC §17.1, M13). Verlangt `control` auf dem Graphen des
 * Raums. Entfernt werden Entität, Inhalt und alle Regeln darauf — ein
 * verwaister Graph mit Regeln wäre ein stiller Rest.
 */

import { NextResponse } from 'next/server';
import { getRequestGraph } from '@/lib/graph/server/context';
import { persistAclSnapshot, persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import { deleteAuthorization, listAuthorizations } from '@/lib/graph/authz/acl-graph';
import { deleteSpace, getSpace } from '@/lib/graph/authz/principals';
import { namedNode } from '@/lib/graph/rdf';

interface RouteContext {
    params: Promise<{ id: string }>;
}

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
    const { id } = await context.params;
    try {
        const { store, iri, grant } = await getRequestGraph();
        const handle = { store, iri };
        const space = await getSpace(handle, id);
        if (!space || !(grant.controlGraphs ?? []).includes(space.graph)) {
            return NextResponse.json({ error: 'Raum nicht gefunden.' }, { status: 404 });
        }
        await store.load([], namedNode(space.graph), { replace: true });
        await deleteSpace(handle, id);
        for (const rule of await listAuthorizations(handle)) {
            if (rule.graph === space.graph) await deleteAuthorization(handle, rule.id);
        }
        await persistAclSnapshot();
        await persistServerGraphSnapshot();
        return NextResponse.json({ deleted: id });
    } catch (error) {
        return NextResponse.json(
            { error: 'Raum nicht aufgelöst', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 },
        );
    }
}
