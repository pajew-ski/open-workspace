/**
 * Aktionen über das Selbstwissen des Graphen (ACTIONS_SPEC, A4): die
 * schema.org-Ansicht, das Selbstmodell (SPEC §18) und die Herkunft der
 * Aussagen (§11). Alles Lesen über das erlaubte Dataset — ohne Leserecht
 * bleibt die Antwort leer, nie verboten (§17.3).
 */

import { z } from 'zod';
import { defineAction } from '@/lib/actions/contract';
import { registerActions } from '@/lib/actions/registry';
import { buildLegacyGraphView } from '../projection/schema-org';
import { provenanceSummary } from '../provenance';
import { readSelfModel } from './self-model-query';

export const graphOverview = defineAction({
    name: 'graph_overview',
    title: 'Graph-Ansicht',
    description: 'Die schema.org-Ansicht des Workspace (Knoten und Kanten) für den Explorer.',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'dataset' },
    async run(_input, ctx) {
        return buildLegacyGraphView(ctx.graph.store, ctx.graph.iri, { allowedGraphs: ctx.grant.readableGraphs });
    },
});

export const selfModel = defineAction({
    name: 'graph_self_model',
    title: 'Selbstmodell',
    description: 'Was dieses System ist und welche Module es hat — per SPARQL aus graph/meta, nicht gepflegt.',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'dataset' },
    async run(_input, ctx) {
        return readSelfModel(ctx.graph.store, ctx.graph.iri, { allowedGraphs: ctx.grant.readableGraphs });
    },
});

export const provenance = defineAction({
    name: 'graph_provenance',
    title: 'Herkunft der Aussagen',
    description: 'Zählt je Named Graph die Aussagen und ordnet sie nach Herkunft: nativ, importiert, inferiert.',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'dataset' },
    async run(_input, ctx) {
        return provenanceSummary(ctx.graph, { allowedGraphs: ctx.grant.readableGraphs });
    },
});

registerActions('graph/meta', [graphOverview, selfModel, provenance]);
