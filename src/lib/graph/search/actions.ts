/**
 * Aktionen der Suche (ACTIONS_SPEC): der Global Finder.
 *
 * `workspace_finder` behält seinen Namen — Skills referenzieren ihn über
 * `[[TOOL:workspace_finder:…]]`, und der AI-Spiegel leitet daraus
 * `ow:requiresTool` ab. Was hier steht, war vorher die Route
 * `/api/finder` plus zwei handgeschriebene Tool-Varianten (Server und
 * Browser); jetzt gibt es eine Definition, und die Route ist ein Adapter.
 */

import { z } from 'zod';
import { defineAction, type ActionContext } from '@/lib/actions/contract';
import { registerActions } from '@/lib/actions/registry';
import { retrievalDataset, buildFulltextIndexForGraphs } from './retrieval';
import { searchWorkspaceGraph, type FinderHit } from './finder';
import { workspaceFromStore } from '../workspace/read';

export const FINDER_TOOL_NAME = 'workspace_finder';

export const finderInputSchema = z.object({
    q: z.string().max(500).describe('Suchbegriff'),
    type: z.enum(['task', 'doc', 'project', 'chat', 'calendar']).optional().describe('Optionaler Typ-Filter'),
    limit: z.number().int().min(1).max(50).optional().describe('Maximale Treffer (Default 50)'),
});

export interface FinderResult {
    type: string;
    id: string;
    title: string;
    subtitle: string;
    url: string;
    matchScore: number;
}

/** Volltext-Index über das erlaubte Wissens-Dataset — aus dem Cache des Servers, sonst frisch. */
async function finderIndex(ctx: ActionContext, dataset: readonly string[]) {
    const deps = await ctx.retrieval?.(dataset);
    return deps?.fulltext ?? buildFulltextIndexForGraphs(ctx.graph, dataset);
}

export const workspaceFinder = defineAction({
    name: FINDER_TOOL_NAME,
    title: 'Workspace durchsuchen',
    description: 'Durchsucht den Workspace: Aufgaben, Dokumente, Projekte, Chats und Termine. Liefert IDs für die anderen Aktionen.',
    input: finderInputSchema,
    effect: 'read',
    target: { kind: 'dataset' },
    async run(input, ctx): Promise<{ results: FinderResult[] }> {
        const query = input.q.trim();
        if (query === '') return { results: [] };
        // Alle Graph-Bürger über den Volltext-Index (Dataset = Wissens-Graphen,
        // §17.4: partitioniert, nicht nachgefiltert).
        const dataset = await retrievalDataset(ctx.graph, {
            includeInferred: false,
            allowedGraphs: ctx.grant.readableGraphs,
        });
        const index = await finderIndex(ctx, dataset);
        const workspace = await workspaceFromStore(ctx.graph.store, ctx.graph.iri);
        const hits: FinderHit[] = searchWorkspaceGraph(index, ctx.graph.iri, workspace, query, input.type ?? null);
        const results = hits
            .map(hit => ({
                type: hit.type,
                id: hit.id,
                title: hit.title,
                subtitle: hit.subtitle,
                url: hit.url,
                matchScore: hit.matchScore,
            }))
            .sort((a, b) => b.matchScore - a.matchScore);
        return { results: results.slice(0, input.limit ?? 50) };
    },
});

registerActions('graph/search', [workspaceFinder]);
