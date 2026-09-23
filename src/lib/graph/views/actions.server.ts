/**
 * Aktionen der gespeicherten Queries (ACTIONS_SPEC, A4; GRAPH_CORE_SPEC
 * §7.1/§9): ow:QueryView in graph/meta als Registry-Einträge des
 * Aufrufers, dazu Auflösung und Vorschau über dasselbe erlaubte Dataset
 * wie jede SPARQL-Anfrage. Serverseitig, weil die Auflösung `SERVICE`
 * gegen registrierte Endpoints über den Föderations-Host löst (M11).
 */

import { z } from 'zod';
import { ActionError, defineAction, notFound, REGISTRY_ERROR_RULES, withStatusFromMessage } from '@/lib/actions/contract';
import { registerActions } from '@/lib/actions/registry';
import { OW } from '../vocab';
import { createFederationResolver } from '../federation/host.server';
import { summarizeFederation } from '../federation/service';
import { isGraphQuery, isReadQuery } from '../sparql/classify';
import { resolveDataset } from '../sparql/protocol';
import { createQueryView, deleteQueryView, getQueryView, listQueryViews, resolveQueryTextAsGraph, resolveQueryView } from './registry';

const viewIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/i, 'Ungültige View-ID');

export const listViews = defineAction({
    name: 'graph_list_views',
    title: 'Gespeicherte Queries auflisten',
    description: 'Listet die gespeicherten SPARQL-Queries (Query-Views) mit Layout-Verfahren.',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'registry' },
    async run(_input, ctx) {
        return { views: await listQueryViews(ctx.graph) };
    },
});

export const getView = defineAction({
    name: 'graph_get_view',
    title: 'Gespeicherte Query lesen',
    description: 'Liest eine gespeicherte Query samt Text.',
    input: z.object({ id: viewIdSchema }),
    effect: 'read',
    target: { kind: 'registry' },
    async run(input, ctx) {
        const view = await getQueryView(ctx.graph, input.id);
        if (!view) throw notFound('View nicht gefunden');
        return { view };
    },
});

/**
 * Graph-förmige Queries (CONSTRUCT/DESCRIBE) werden beim Anlegen einmal
 * probeweise aufgelöst, SELECT/ASK probeweise ausgeführt — lieber ein
 * klarer Fehler als eine tote Karteileiche (Invariante 10). Updates sind
 * nicht speicherbar (lesende Queries, SPEC §7.1).
 */
export const createView = defineAction({
    name: 'graph_create_view',
    title: 'Query speichern',
    description: 'Speichert eine lesende SPARQL-Query (SELECT, ASK, CONSTRUCT, DESCRIBE) als Query-View.',
    input: z.object({
        name: z.string().min(1, 'Name ist erforderlich').max(200),
        queryText: z.string().min(1, 'SPARQL-Query ist erforderlich').max(100_000),
        layoutMethod: z.enum(['force-directed', 'hierarchical', 'radial']),
    }),
    effect: 'constructive',
    target: { kind: 'registry' },
    changes: [OW.QueryView],
    async run(input, ctx) {
        if (!isReadQuery(input.queryText)) {
            throw new ActionError(400, 'Nur lesende Queries sind speicherbar',
                'SELECT, ASK, CONSTRUCT oder DESCRIBE — Updates werden nicht als gespeicherte Query abgelegt.');
        }
        let view;
        try {
            view = await createQueryView(ctx.graph, input);
        } catch (error) {
            return withStatusFromMessage(error, REGISTRY_ERROR_RULES);
        }
        try {
            if (isGraphQuery(input.queryText)) {
                await resolveQueryView(ctx.graph, view.id, { allowedGraphs: ctx.grant.readableGraphs });
            } else {
                const dataset = await resolveDataset(ctx.graph.store, ctx.graph.iri, undefined, {
                    allowedGraphs: ctx.grant.readableGraphs,
                });
                await ctx.graph.store.query(input.queryText, {
                    defaultGraphs: dataset.defaultGraphs,
                    namedGraphs: dataset.namedGraphs,
                    timeoutMs: 30_000,
                });
            }
        } catch (error) {
            await deleteQueryView(ctx.graph, view.id);
            throw new ActionError(400, 'Query ist nicht ausführbar', error instanceof Error ? error.message : 'unknown');
        }
        await ctx.persist?.snapshot();
        return { view };
    },
});

export const deleteView = defineAction({
    name: 'graph_delete_view',
    title: 'Gespeicherte Query löschen',
    description: 'Entfernt eine gespeicherte Query.',
    input: z.object({ id: viewIdSchema }),
    effect: 'destructive',
    target: { kind: 'registry' },
    changes: [OW.QueryView],
    async run(input, ctx) {
        const deleted = await deleteQueryView(ctx.graph, input.id);
        if (!deleted) throw notFound('View nicht gefunden');
        await ctx.persist?.snapshot();
        return { success: true as const };
    },
});

export const resolveView = defineAction({
    name: 'graph_resolve_view',
    title: 'Query-View auflösen',
    description: 'Führt eine gespeicherte graph-förmige Query aus und liefert den Subgraphen (Knoten, Kanten, gekappt).',
    input: z.object({ id: viewIdSchema }),
    effect: 'read',
    target: { kind: 'dataset' },
    async run(input, ctx) {
        try {
            return await resolveQueryView(ctx.graph, input.id, { allowedGraphs: ctx.grant.readableGraphs });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'unknown';
            throw new ActionError(message.includes('nicht registriert') ? 404 : 400, 'View nicht auflösbar', message);
        }
    },
});

export const previewQuery = defineAction({
    name: 'graph_preview_query',
    title: 'Query als Graph',
    description: 'Löst eine graph-förmige SPARQL-Query (CONSTRUCT/DESCRIBE) als Subgraphen auf, ohne sie zu speichern.',
    input: z.object({ queryText: z.string().min(1).max(100_000) }),
    effect: 'read',
    target: { kind: 'dataset' },
    async run(input, ctx) {
        const federation = createFederationResolver();
        try {
            const resolved = await resolveQueryTextAsGraph(ctx.graph, input.queryText, {
                federation: federation.resolve,
                allowedGraphs: ctx.grant.readableGraphs,
            });
            const report = federation.report();
            return report.calls.length > 0 ? { ...resolved, federation: summarizeFederation(report) } : resolved;
        } catch (error) {
            throw new ActionError(400, 'Query nicht als Graph auflösbar', error instanceof Error ? error.message : 'unknown');
        }
    },
});

registerActions('graph/views', [listViews, getView, createView, deleteView, resolveView, previewQuery]);
