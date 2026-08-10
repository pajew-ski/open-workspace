/**
 * Geteilte Räume (SPEC §17.1, M13).
 *
 * `POST /api/graph/access/spaces` legt einen Raum an: eine `ow:Space`-
 * Entität in `graph/meta` plus die Eigentümer-Regel auf
 * `graph/shared/<id>`. Eigentümer ist immer der Anlegende — ein Raum im
 * Namen eines anderen wäre eine Rechtevergabe ohne dessen Zutun.
 *
 * Der Graph des Raums entsteht erst mit seinem ersten Quad; die Regel
 * steht trotzdem sofort, sonst könnte niemand hineinschreiben.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getRequestGraph } from '@/lib/graph/server/context';
import { persistAclSnapshot, persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import { createSpace, listSpaces } from '@/lib/graph/authz/principals';
import { setAuthorization } from '@/lib/graph/authz/acl-graph';

const bodySchema = z.object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
}).strict();

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
    try {
        const { store, iri, grant } = await getRequestGraph();
        const readable = new Set(grant.readableGraphs);
        const control = new Set(grant.controlGraphs ?? []);
        // Ein Raum, den man nicht lesen darf, taucht nicht auf — auch
        // nicht als Name (§17.3: keine Existenzbestätigung).
        const spaces = (await listSpaces({ store, iri }))
            .filter(space => readable.has(space.graph) || control.has(space.graph))
            .map(space => ({ ...space, manageable: control.has(space.graph) }));
        return NextResponse.json({ spaces });
    } catch (error) {
        console.error('Spaces Error:', error);
        return NextResponse.json({ error: 'Räume nicht ermittelbar.' }, { status: 500 });
    }
}

export async function POST(request: Request): Promise<Response> {
    let body: z.infer<typeof bodySchema>;
    try {
        body = bodySchema.parse(await request.json());
    } catch (error) {
        const message = error instanceof z.ZodError
            ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
            : 'Ungültiger Request-Body.';
        return NextResponse.json({ error: message }, { status: 400 });
    }

    try {
        const { store, iri, identity, grant } = await getRequestGraph();
        if (!grant.userId) {
            return NextResponse.json(
                { error: 'Räume kann nur eine angemeldete Identität anlegen.' },
                { status: 403 },
            );
        }
        const handle = { store, iri };
        const space = await createSpace(handle, {
            id: body.id,
            name: body.name,
            owner: identity.userId,
            ...(body.description ? { description: body.description } : {}),
        });
        await setAuthorization(handle, {
            graph: space.graph,
            principal: { kind: 'user', id: identity.userId },
            modes: ['control'],
            managed: true,
        });
        await persistAclSnapshot();
        await persistServerGraphSnapshot();
        return NextResponse.json({ space }, { status: 201 });
    } catch (error) {
        return NextResponse.json(
            { error: 'Raum nicht angelegt', details: error instanceof Error ? error.message : 'unknown' },
            { status: 400 },
        );
    }
}
