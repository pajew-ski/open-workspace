/**
 * Aktionen der Zugriffsverwaltung (ACTIONS_SPEC, A4; GRAPH_CORE_SPEC §17):
 * Übersicht, Freigaben, Gruppen, Räume, Freigabehandlung. Jede Erlaubnis
 * kommt aus dem Grant — `control` auf dem betroffenen Graphen für
 * Freigaben und Räume, `control` auf graph/meta für Gruppen, Lesen auf
 * der Quelle und Schreiben auf dem Ziel für die Freigabehandlung. Es gibt
 * keine Verwalter-Hintertür: Verwalter sind Nutzer mit `control`, und das
 * steht in graph/acl.
 */

import { z } from 'zod';
import { ActionDeniedError, defineAction, notFound, withStatusFromMessage, type ActionContext } from '@/lib/actions/contract';
import { mayAccessGraph } from '@/lib/actions/authorize';
import { registerActions } from '@/lib/actions/registry';
import { namedNode } from '../rdf';
import { OW } from '../vocab';
import { ACL_MODES, ROLE_LABELS, ROLE_MODES, SPACE_ROLES, isSpaceRole, type AclMode } from './acl';
import { deleteAuthorization, graphLabel, listAuthorizations, setAuthorization, type AuthorizationPrincipal } from './acl-graph';
import { createSpace, deleteGroup, deleteSpace, getSpace, listGroups, listSpaces, listUsers, setGroup } from './principals';
import { publishEntity } from './publish';

const principalSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('user'), id: z.string().min(1).max(100) }),
    z.object({ kind: z.literal('group'), id: z.string().min(1).max(100) }),
    z.object({ kind: z.literal('authenticated') }),
    z.object({ kind: z.literal('public') }),
]);

const META_CONTROL = { kind: 'graph', scope: 'meta', mode: 'control' } as const;

/**
 * Übersicht für die aktuelle Identität: wer bin ich, was darf ich sehen
 * und verwalten, welche Nutzer, Gruppen und Räume gibt es. Regeln zeigt
 * sie nur, wo `control` besteht — die Mitgliederliste ist selbst eine
 * Information.
 */
export const accessOverview = defineAction({
    name: 'access_overview',
    title: 'Zugriffs-Übersicht',
    description: 'Identität, lesbare und verwaltbare Graphen, Freigaberegeln (nur wo verwaltbar), Nutzer, Gruppen und Räume.',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'dataset' },
    async run(_input, ctx) {
        const { grant } = ctx;
        const control = new Set(grant.controlGraphs ?? []);
        const writable = new Set(grant.writableGraphs ?? []);
        const appendable = new Set(grant.appendableGraphs ?? []);
        const authorizations = (await listAuthorizations(ctx.graph)).filter(rule => control.has(rule.graph));
        const spaces = await listSpaces(ctx.graph);
        return {
            identity: {
                userId: ctx.identity.userId,
                displayName: ctx.identity.displayName ?? null,
                // Die Seite zeigt Verfahren, Gruppen und Grund — dieselben
                // Felder wie vor der Migration (sonst bricht sie im Render).
                mode: ctx.identity.mode ?? null,
                authenticated: ctx.identity.authenticated,
                groups: ctx.identity.groups ?? [],
                reason: ctx.identity.reason ?? null,
                label: ctx.identity.label,
            },
            capabilities: { multiUser: ctx.platform?.runtime.capabilities.multiUser ?? false },
            graphs: grant.readableGraphs.map(graph => ({
                iri: graph,
                label: graphLabel(ctx.graph.iri.instanceBase, graph),
                modes: [
                    'read',
                    ...(appendable.has(graph) ? ['append'] : []),
                    ...(writable.has(graph) ? ['write'] : []),
                    ...(control.has(graph) ? ['control'] : []),
                ],
            })),
            authorizations,
            users: await listUsers(ctx.graph),
            groups: await listGroups(ctx.graph),
            spaces: spaces.map(space => ({ ...space, manageable: control.has(space.graph) })),
            /** Katalog für die UI — eine Quelle für Beschriftungen. */
            modes: ACL_MODES,
            roles: SPACE_ROLES.map(role => ({ role, label: ROLE_LABELS[role], modes: ROLE_MODES[role] })),
        };
    },
});

/** Eine leere Modus-Liste löscht die Regel — „keine Rechte" ist die Abwesenheit einer Regel. */
export const setAuthorizationAction = defineAction({
    name: 'access_set_authorization',
    title: 'Freigabe setzen',
    description: 'Setzt die Regel für einen Prinzipal auf einem Graphen (Modi oder Rolle); leere Modi entfernen sie.',
    input: z.object({
        graph: z.string().min(1).describe('IRI des Graphen'),
        principal: principalSchema,
        modes: z.array(z.enum(ACL_MODES)).optional(),
        role: z.string().optional().describe('Rolle als Abkürzung (reader, contributor, editor, owner)'),
    }).strict(),
    effect: 'constructive',
    target: { kind: 'graph', scope: input => (input as { graph: string }).graph, mode: 'control' },
    changes: [OW.Space],
    async run(input, ctx) {
        let modes: AclMode[];
        if (input.role !== undefined) {
            if (!isSpaceRole(input.role)) throw withStatusFromMessage(new Error(`Ungültige Rolle "${input.role}".`), [[/./, 400]]);
            modes = [...ROLE_MODES[input.role]];
        } else {
            modes = input.modes ?? [];
        }
        const record = await setAuthorization(ctx.graph, {
            graph: input.graph,
            principal: input.principal as AuthorizationPrincipal,
            modes,
        });
        await ctx.persist?.acl();
        return { authorization: record };
    },
});

export const deleteAuthorizationAction = defineAction({
    name: 'access_delete_authorization',
    title: 'Freigabe zurücknehmen',
    description: 'Entfernt eine Freigaberegel; verlangt die Verwaltung des Graphen, für den sie gilt.',
    input: z.object({ id: z.string().min(1).max(200) }),
    effect: 'destructive',
    target: {
        kind: 'graph',
        mode: 'control',
        // Unbekannte Regel und fremde Regel sehen identisch aus (404).
        scope: async (input, ctx) => {
            const rule = (await listAuthorizations(ctx.graph)).find(entry => entry.id === (input as { id: string }).id);
            if (!rule) throw notFound('Regel nicht gefunden.');
            return rule.graph;
        },
    },
    changes: [OW.Space],
    async run(input, ctx) {
        await deleteAuthorization(ctx.graph, input.id);
        await ctx.persist?.acl();
        return { deleted: input.id };
    },
});

export const setGroupAction = defineAction({
    name: 'access_set_group',
    title: 'Gruppe setzen',
    description: 'Legt eine Gruppe an oder ersetzt ihre Mitglieder (Prinzipal für Freigaben).',
    input: z.object({
        id: z.string().min(1).max(100),
        name: z.string().min(1).max(200).optional(),
        members: z.array(z.string().min(1).max(100)).max(500),
    }).strict(),
    effect: 'constructive',
    target: META_CONTROL,
    changes: [OW.Space],
    async run(input, ctx) {
        try {
            const group = await setGroup(ctx.graph, {
                id: input.id,
                ...(input.name ? { name: input.name } : {}),
                members: input.members,
            });
            await ctx.persist?.snapshot();
            return { group };
        } catch (error) {
            return withStatusFromMessage(error, [[/./, 400]]);
        }
    },
});

/** Regeln auf die Gruppe bleiben stehen und laufen ins Leere — sie geben niemandem Rechte. */
export const deleteGroupAction = defineAction({
    name: 'access_delete_group',
    title: 'Gruppe löschen',
    description: 'Entfernt eine Gruppe.',
    input: z.object({ id: z.string().min(1).max(100) }),
    effect: 'destructive',
    target: META_CONTROL,
    changes: [OW.Space],
    async run(input, ctx) {
        const removed = await deleteGroup(ctx.graph, input.id);
        if (!removed) throw notFound('Gruppe nicht gefunden.');
        await ctx.persist?.snapshot();
        return { deleted: input.id };
    },
});

/** Ein Raum, den man nicht lesen darf, taucht nicht auf — auch nicht als Name (§17.3). */
export const listSpacesAction = defineAction({
    name: 'access_list_spaces',
    title: 'Räume auflisten',
    description: 'Listet die geteilten Räume, die der Aufrufer lesen oder verwalten darf.',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'dataset' },
    async run(_input, ctx) {
        const readable = new Set(ctx.grant.readableGraphs);
        const control = new Set(ctx.grant.controlGraphs ?? []);
        const spaces = (await listSpaces(ctx.graph))
            .filter(space => readable.has(space.graph) || control.has(space.graph))
            .map(space => ({ ...space, manageable: control.has(space.graph) }));
        return { spaces };
    },
});

/** Eigentümer ist immer der Anlegende — ein Raum im Namen eines anderen wäre eine Rechtevergabe ohne dessen Zutun. */
export const createSpaceAction = defineAction({
    name: 'access_create_space',
    title: 'Raum anlegen',
    description: 'Legt einen geteilten Raum an; der Anlegende wird Eigentümer.',
    input: z.object({
        id: z.string().min(1).max(100),
        name: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
    }).strict(),
    effect: 'constructive',
    target: { kind: 'graph', scope: input => `shared/${(input as { id: string }).id}` },
    changes: [OW.Space],
    async run(input, ctx) {
        try {
            const space = await createSpace(ctx.graph, {
                id: input.id,
                name: input.name,
                owner: ctx.identity.userId,
                ...(input.description ? { description: input.description } : {}),
            });
            await setAuthorization(ctx.graph, {
                graph: space.graph,
                principal: { kind: 'user', id: ctx.identity.userId },
                modes: ['control'],
                managed: true,
            });
            await ctx.persist?.acl();
            await ctx.persist?.snapshot();
            return { space };
        } catch (error) {
            return withStatusFromMessage(error, [[/./, 400]]);
        }
    },
});

/** Entfernt Entität, Inhalt und alle Regeln — ein verwaister Graph mit Regeln wäre ein stiller Rest. */
export const deleteSpaceAction = defineAction({
    name: 'access_delete_space',
    title: 'Raum auflösen',
    description: 'Löst einen geteilten Raum auf: Entität, Inhalt und alle Regeln darauf.',
    input: z.object({ id: z.string().min(1).max(100) }),
    effect: 'destructive',
    target: {
        kind: 'graph',
        mode: 'control',
        scope: async (input, ctx) => {
            const space = await getSpace(ctx.graph, (input as { id: string }).id);
            if (!space) throw notFound('Raum nicht gefunden.');
            return space.graph;
        },
    },
    changes: [OW.Space],
    async run(input, ctx) {
        const space = await getSpace(ctx.graph, input.id);
        if (!space) throw notFound('Raum nicht gefunden.');
        await ctx.graph.store.load([], namedNode(space.graph), { replace: true });
        await deleteSpace(ctx.graph, input.id);
        for (const rule of await listAuthorizations(ctx.graph)) {
            if (rule.graph === space.graph) await deleteAuthorization(ctx.graph, rule.id);
        }
        await ctx.persist?.acl();
        await ctx.persist?.snapshot();
        return { deleted: input.id };
    },
});

async function targetGraphOfPublish(input: unknown, ctx: ActionContext): Promise<string> {
    return (input as { to?: string }).to ?? ctx.graph.iri.graph('public');
}

/**
 * Kopiert oder verschiebt einen Knoten aus einem Graphen in einen anderen
 * (typisch Workspace → öffentlich), protokolliert als prov:Activity. Zwei
 * Rechte, beide nötig: Lesen auf der Quelle, Schreiben auf dem Ziel —
 * das Ziel prüft der Vertrag, die Quelle dieselbe Regel (`mayAccessGraph`).
 */
export const publishAction = defineAction({
    name: 'access_publish',
    title: 'Knoten freigeben',
    description: 'Kopiert oder verschiebt einen Knoten in einen anderen Graphen, typisch vom Workspace in den öffentlichen Graphen.',
    input: z.object({
        iri: z.string().min(1).describe('IRI des Knotens'),
        mode: z.enum(['copy', 'move']).default('copy'),
        from: z.string().optional().describe('Quellgraph (Default: eigener Workspace)'),
        to: z.string().optional().describe('Zielgraph (Default: eigener öffentlicher Graph)'),
    }).strict(),
    effect: 'constructive',
    target: { kind: 'graph', scope: targetGraphOfPublish, mode: 'write' },
    changes: [OW.Document, OW.Task, OW.Project],
    async run(input, ctx) {
        const from = input.from ?? ctx.graph.iri.graph('workspace');
        const to = input.to ?? ctx.graph.iri.graph('public');
        // Verschieben nimmt aus der Quelle weg — dafür reicht Lesen nicht.
        const sourceMode = input.mode === 'copy' ? 'read' : 'write';
        if (!(await mayAccessGraph(ctx, from, sourceMode))) {
            // Kein Unterschied zwischen „gibt es nicht" und „darfst du nicht" (§17.3).
            throw notFound('Graph nicht gefunden.');
        }
        try {
            const report = await publishEntity(ctx.graph, {
                entityIri: input.iri,
                from,
                to,
                mode: input.mode,
                actor: ctx.identity.userId,
            });
            await ctx.persist?.snapshot();
            return { report };
        } catch (error) {
            if (error instanceof ActionDeniedError) throw error;
            return withStatusFromMessage(error, [[/./, 400]]);
        }
    },
});

registerActions('graph/authz', [
    accessOverview, setAuthorizationAction, deleteAuthorizationAction, setGroupAction, deleteGroupAction,
    listSpacesAction, createSpaceAction, deleteSpaceAction, publishAction,
]);
