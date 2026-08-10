/**
 * Gruppen (SPEC §17.1, M13): `foaf:Group` mit `foaf:member` in
 * `graph/meta`. Rechte werden an Nutzer **und** Gruppen vergeben — die
 * Gruppe selbst trägt keine Rechte, sie ist ein Prinzipal.
 *
 * Gruppen sind instanzweit; sie zu ändern verlangt deshalb `control` auf
 * `graph/meta` — dieselbe Schwelle wie für jede andere instanzweite
 * Aussage. Gruppen aus dem Identitätsanbieter (OIDC-Claim, Proxy-Header)
 * brauchen hier keinen Eintrag: Sie greifen über denselben Prinzipal, nur
 * ohne Mitgliederliste im Graphen.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getRequestGraph } from '@/lib/graph/server/context';
import { persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import { setGroup } from '@/lib/graph/authz/principals';

const bodySchema = z.object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(200).optional(),
    members: z.array(z.string().min(1).max(100)).max(500),
}).strict();

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
        const { store, iri, grant } = await getRequestGraph();
        if (!(grant.controlGraphs ?? []).includes(iri.sharedGraph('meta'))) {
            return NextResponse.json(
                { error: 'Gruppen verwalten darf nur, wer graph/meta verwaltet.' },
                { status: 403 },
            );
        }
        const group = await setGroup({ store, iri }, {
            id: body.id,
            ...(body.name ? { name: body.name } : {}),
            members: body.members,
        });
        await persistServerGraphSnapshot();
        return NextResponse.json({ group }, { status: 201 });
    } catch (error) {
        return NextResponse.json(
            { error: 'Gruppe nicht gespeichert', details: error instanceof Error ? error.message : 'unknown' },
            { status: 400 },
        );
    }
}
