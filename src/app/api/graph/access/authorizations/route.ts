/**
 * Freigaben setzen (SPEC §17.2, M13).
 *
 * `POST /api/graph/access/authorizations` — eine Regel je Graph und
 * Prinzipal. Voraussetzung ist `control` auf genau diesem Graphen; es
 * gibt keine Verwalter-Hintertür im Code (§17.2: Verwalter sind Nutzer
 * mit `control`, und das steht in `graph/acl`).
 *
 * Eine leere Modus-Liste löscht die Regel — „keine Rechte" ist die
 * Abwesenheit einer Regel, kein Regel-Zustand.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getRequestGraph } from '@/lib/graph/server/context';
import { persistAclSnapshot } from '@/lib/graph/server/instance';
import { setAuthorization, type AuthorizationPrincipal } from '@/lib/graph/authz/acl-graph';
import { ACL_MODES, ROLE_MODES, isSpaceRole, type AclMode } from '@/lib/graph/authz/acl';

const principalSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('user'), id: z.string().min(1).max(100) }),
    z.object({ kind: z.literal('group'), id: z.string().min(1).max(100) }),
    z.object({ kind: z.literal('authenticated') }),
    z.object({ kind: z.literal('public') }),
]);

const bodySchema = z.object({
    graph: z.string().min(1),
    principal: principalSchema,
    /** Entweder Modi direkt oder eine Rolle als Abkürzung (§17.1). */
    modes: z.array(z.enum(ACL_MODES)).optional(),
    role: z.string().optional(),
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

    let modes: AclMode[];
    if (body.role !== undefined) {
        if (!isSpaceRole(body.role)) {
            return NextResponse.json({ error: `Unbekannte Rolle "${body.role}".` }, { status: 400 });
        }
        modes = [...ROLE_MODES[body.role]];
    } else {
        modes = body.modes ?? [];
    }

    try {
        const { store, iri, grant } = await getRequestGraph();
        if (!(grant.controlGraphs ?? []).includes(body.graph)) {
            // Kein Unterschied zwischen „gibt es nicht" und „darfst du
            // nicht verwalten" (§17.3): beides ist dieselbe Antwort.
            return NextResponse.json(
                { error: 'Dieser Graph ist für dich nicht verwaltbar.' },
                { status: 403 },
            );
        }
        const record = await setAuthorization({ store, iri }, {
            graph: body.graph,
            principal: body.principal as AuthorizationPrincipal,
            modes,
        });
        await persistAclSnapshot();
        return NextResponse.json({ authorization: record }, { status: record ? 201 : 200 });
    } catch (error) {
        return NextResponse.json(
            { error: 'Freigabe nicht gesetzt', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 },
        );
    }
}
