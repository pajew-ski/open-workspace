/**
 * Aktionen des Reasonings (ACTIONS_SPEC, A4): Zustand und Lauf der
 * OWL-RL-Materialisierung (SPEC §7.3) und die On-demand-SHACL-Validierung
 * (§7.2, Stelle 3). Ein Lauf schreibt die Inferenz-Graphen des Aufrufers
 * neu — die persistiert niemand (§8.1).
 */

import { z } from 'zod';
import { defineAction } from '@/lib/actions/contract';
import { registerActions } from '@/lib/actions/registry';
import { PROV } from '../vocab';
import { inferredTriples, reasoningStatus, runReasoning, validateStoreGraphs } from './run';

export const reasoningState = defineAction({
    name: 'graph_reasoning_status',
    title: 'Reasoning-Zustand',
    description: 'Zustand der scope-partitionierten Inferenz-Graphen plus die abgeleiteten Tripel des Workspace (gekappt).',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'dataset' },
    async run(_input, ctx) {
        return {
            status: await reasoningStatus(ctx.graph),
            triples: await inferredTriples(ctx.graph, 'workspace'),
        };
    },
});

export const reasoningRun = defineAction({
    name: 'graph_reasoning_run',
    title: 'Reasoning ausführen',
    description: 'Materialisiert die Inferenz-Graphen neu (vollständiger Replace je Scope).',
    input: z.object({}),
    effect: 'constructive',
    target: { kind: 'graph', scope: 'inferred/workspace' },
    changes: [PROV.Activity],
    async run(_input, ctx) {
        return {
            runs: await runReasoning(ctx.graph),
            triples: await inferredTriples(ctx.graph, 'workspace'),
        };
    },
});

export const validate = defineAction({
    name: 'graph_validate',
    title: 'SHACL-Validierung',
    description: 'Validiert die Wissens-Graphen gegen graph/shapes und liefert den Befund — berichtend, nie blockierend.',
    input: z.object({
        graphs: z.array(z.string().max(2048)).max(100).optional().describe('Nur diese Graphen (IRIs)'),
    }),
    effect: 'read',
    target: { kind: 'dataset' },
    async run(input, ctx) {
        return { report: await validateStoreGraphs(ctx.graph, input.graphs) };
    },
});

registerActions('graph/reasoning', [reasoningState, reasoningRun, validate]);
