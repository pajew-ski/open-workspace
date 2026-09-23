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
import { defineAction, notFound, REGISTRY_ERROR_RULES, withStatusFromMessage, type ActionContext } from '@/lib/actions/contract';
import { registerActions } from '@/lib/actions/registry';
import { OW } from '../vocab';
import { retrievalDataset, buildFulltextIndexForGraphs } from './retrieval';
import { createRetrievalProfile, deleteRetrievalProfile, getRetrievalProfile, listRetrievalProfiles } from './profiles';
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

// ---------------------------------------------------------------------------
// Retrieval-Profile (SPEC §7.5, M8): gespeicherte Parametersätze als
// ow:RetrievalProfile in graph/meta — Registry-Einträge des Aufrufers.
// ---------------------------------------------------------------------------

export const listProfiles = defineAction({
    name: 'graph_list_retrieval_profiles',
    title: 'Retrieval-Profile auflisten',
    description: 'Listet die gespeicherten Retrieval-Profile (Parametersätze für graph_retrieve).',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'registry' },
    async run(_input, ctx) {
        return { profiles: await listRetrievalProfiles(ctx.graph) };
    },
});

export const getProfile = defineAction({
    name: 'graph_get_retrieval_profile',
    title: 'Retrieval-Profil lesen',
    description: 'Liest ein gespeichertes Retrieval-Profil.',
    input: z.object({ id: z.string().min(1).max(200) }),
    effect: 'read',
    target: { kind: 'registry' },
    async run(input, ctx) {
        const profile = await getRetrievalProfile(ctx.graph, input.id);
        if (!profile) throw notFound(`Retrieval-Profil "${input.id}" existiert nicht.`);
        return { profile };
    },
});

export const createProfile = defineAction({
    name: 'graph_create_retrieval_profile',
    title: 'Retrieval-Profil anlegen',
    description: 'Speichert einen Parametersatz für graph_retrieve als Profil (auch als MCP-Prompt sichtbar).',
    input: z.object({
        name: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        config: z.record(z.string(), z.unknown()).default({}).describe('RetrievalRequest-Parameter'),
    }).strict(),
    effect: 'constructive',
    target: { kind: 'registry' },
    changes: [OW.RetrievalProfile],
    async run(input, ctx) {
        try {
            const profile = await createRetrievalProfile(ctx.graph, {
                name: input.name,
                description: input.description,
                config: input.config,
            });
            await ctx.persist?.snapshot();
            return { profile };
        } catch (error) {
            return withStatusFromMessage(error, REGISTRY_ERROR_RULES);
        }
    },
});

export const deleteProfile = defineAction({
    name: 'graph_delete_retrieval_profile',
    title: 'Retrieval-Profil löschen',
    description: 'Entfernt ein gespeichertes Retrieval-Profil.',
    input: z.object({ id: z.string().min(1).max(200) }),
    effect: 'destructive',
    target: { kind: 'registry' },
    changes: [OW.RetrievalProfile],
    async run(input, ctx) {
        const removed = await deleteRetrievalProfile(ctx.graph, input.id);
        if (!removed) throw notFound(`Retrieval-Profil "${input.id}" existiert nicht.`);
        await ctx.persist?.snapshot();
        return { ok: true as const };
    },
});

registerActions('graph/search', [listProfiles, getProfile, createProfile, deleteProfile]);
