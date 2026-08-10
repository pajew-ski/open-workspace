/**
 * Zugriffs-Übersicht (SPEC §17, M13) — Lesemodell der Verwaltungs-UI.
 *
 * `GET /api/graph/access` beantwortet für die aktuelle Identität:
 * Wer bin ich, was darf ich sehen, was darf ich verwalten, welche Nutzer,
 * Gruppen und Räume gibt es — und welche Regeln gelten auf den Graphen,
 * die ich verwalte.
 *
 * **Regeln zeigt die Route nur, wo `control` besteht.** Wer einen Graphen
 * nur lesen darf, erfährt nicht, wer ihn sonst noch lesen darf: die
 * Mitgliederliste ist selbst eine Information.
 */

import { NextResponse } from 'next/server';
import { getRequestGraph } from '@/lib/graph/server/context';
import { graphLabel, listAuthorizations } from '@/lib/graph/authz/acl-graph';
import { listGroups, listSpaces, listUsers } from '@/lib/graph/authz/principals';
import { ACL_MODES, ROLE_LABELS, ROLE_MODES, SPACE_ROLES } from '@/lib/graph/authz/acl';
import { createNodeRuntimeAdapter } from '@/lib/platform/runtime/server';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
    try {
        const { store, iri, identity, grant } = await getRequestGraph();
        const handle = { store, iri };
        const control = new Set(grant.controlGraphs ?? []);
        const writable = new Set(grant.writableGraphs ?? []);
        const appendable = new Set(grant.appendableGraphs ?? []);

        const authorizations = (await listAuthorizations(handle)).filter(rule => control.has(rule.graph));
        const spaces = await listSpaces(handle);

        return NextResponse.json({
            identity: {
                userId: identity.userId,
                displayName: identity.displayName ?? null,
                mode: identity.mode,
                authenticated: identity.authenticated,
                groups: identity.groups,
                reason: identity.reason ?? null,
            },
            capabilities: { multiUser: createNodeRuntimeAdapter().capabilities.multiUser },
            graphs: grant.readableGraphs.map(graph => ({
                iri: graph,
                label: graphLabel(iri.instanceBase, graph),
                modes: [
                    'read',
                    ...(appendable.has(graph) ? ['append'] : []),
                    ...(writable.has(graph) ? ['write'] : []),
                    ...(control.has(graph) ? ['control'] : []),
                ],
            })),
            authorizations,
            users: await listUsers(handle),
            groups: await listGroups(handle),
            spaces: spaces.map(space => ({ ...space, manageable: control.has(space.graph) })),
            /** Katalog für die UI — eine Quelle für Beschriftungen. */
            modes: ACL_MODES,
            roles: SPACE_ROLES.map(role => ({ role, label: ROLE_LABELS[role], modes: ROLE_MODES[role] })),
        });
    } catch (error) {
        console.error('Access Overview Error:', error);
        return NextResponse.json({ error: 'Zugriffs-Übersicht nicht ermittelbar.' }, { status: 500 });
    }
}
