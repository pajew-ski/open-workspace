/**
 * Die Graph-Werkzeuge des MCP-Servers als Aktionen (ACTIONS_SPEC, A2):
 * `graph_search`, `graph_retrieve`, `graph_neighbors`, `graph_describe`,
 * `graph_sparql`, `graph_write` — Namen und Rechtemodell unverändert
 * (SPEC §7.6), jetzt EINE Definition für den MCP-Server, den Tool-Loop des
 * Assistenten, die Routen `/api/graph/search` und `/api/graph/retrieve`
 * und das Selbstmodell.
 *
 * Die Operationen selbst stehen in `tools.ts`; hier liegt nur der Vertrag
 * darum. Der `McpGraphContext` der Operationen entsteht aus dem
 * `ActionContext`, der alles trägt, was die Operationen brauchen.
 */

import { z } from 'zod';
import { ActionError, defineAction, notFound, type ActionContext } from '@/lib/actions/contract';
import { registerActions } from '@/lib/actions/registry';
import { OW } from '../vocab';
import { getRetrievalProfile } from '../search/profiles';
import type { RetrievalRequestInput } from '../search/retrieval';
import {
    mcpDescribe,
    mcpNeighbors,
    mcpRetrieve,
    mcpSearch,
    mcpSparql,
    mcpWrite,
    McpWriteDeniedError,
    type McpGraphContext,
} from './tools';

/** Operations-Kontext aus dem Aktionskontext — dieselben Bausteine, umgehängt. */
export function graphContextOf(ctx: ActionContext, options: { vector?: boolean } = {}): McpGraphContext {
    return {
        handle: ctx.graph,
        grant: ctx.grant,
        actions: ctx,
        ...(ctx.retrieval ? { retrievalDeps: (dataset: readonly string[]) => ctx.retrieval!(dataset, options) } : {}),
        ...(ctx.now ? { now: ctx.now } : {}),
        ...(ctx.persist ? { afterWrite: () => ctx.persist!.snapshot() } : {}),
    };
}

const typeFilterSchema = z.object({
    include: z.array(z.string()).max(50).optional(),
    exclude: z.array(z.string()).max(50).optional(),
}).strict();

/**
 * Kausale Erdung (CAUSAL_LAYER_SPEC §9, C2). `paths` braucht beide Enden —
 * das wird hier abgewiesen statt später still zu einem leeren Ergebnis zu
 * führen; alle anderen Modi brauchen mindestens eines von beiden.
 */
const causalSchema = z.object({
    mode: z.enum(['ancestors', 'descendants', 'paths', 'markov-blanket'])
        .describe('ancestors = Ursachenseite, descendants = Folgenseite, paths = Wege, markov-blanket = Kragen'),
    treatment: z.string().max(2000).optional().describe('IRI der Ursache'),
    outcome: z.string().max(2000).optional().describe('IRI der Wirkung'),
    model: z.string().max(2000).optional().describe('Kennung oder IRI des Kausalmodells (Default: das einzige)'),
    blockedBy: z.array(z.string().max(2000)).max(50).optional()
        .describe('Konditionierungsmenge — d-separierte Größen fallen aus dem Kontext'),
    minEvidence: z.enum(['hypothesis', 'estimated', 'refuted-clean']).optional()
        .describe('Mindest-Belegstand je Kante'),
}).strict().refine(
    value => value.mode !== 'paths' || (Boolean(value.treatment) && Boolean(value.outcome)),
    { message: 'Modus „paths" braucht treatment UND outcome.' },
).refine(
    value => Boolean(value.treatment) || Boolean(value.outcome),
    { message: 'Ohne treatment oder outcome gibt es keinen Bezugspunkt im Kausalmodell.' },
);

export const retrieveInputSchema = z.object({
    seeds: z.object({
        iri: z.array(z.string()).max(100).optional(),
        text: z.string().max(2000).optional(),
        vector: z.array(z.number()).max(8192).optional(),
    }).strict().optional(),
    maxHops: z.number().int().min(1).max(4).optional(),
    maxNodes: z.number().int().min(1).max(500).optional(),
    edgeTypes: typeFilterSchema.optional(),
    nodeTypes: typeFilterSchema.optional(),
    direction: z.enum(['out', 'in', 'both']).optional(),
    graphs: z.array(z.string()).max(50).optional(),
    decay: z.number().min(0).max(1).optional(),
    maxDegree: z.number().int().min(1).max(10_000).optional(),
    includeInferred: z.boolean().optional(),
    format: z.enum(['subgraph', 'context', 'both']).optional().describe('Default: context'),
    tokenBudget: z.number().int().min(50).max(100_000).optional(),
    seedLimit: z.number().int().min(1).max(100).optional(),
    profile: z.string().max(200).optional().describe('ID eines gespeicherten Retrieval-Profils als Basis'),
    causal: causalSchema.optional().describe('Kausale Erdung nach CAUSAL_LAYER_SPEC §9'),
}).strict();

export const graphSearch = defineAction({
    name: 'graph_search',
    title: 'Graph durchsuchen',
    description: 'Volltext- (und optional Vektor-)Suche über alle Literale des Wissensgraphen. Liefert Kandidaten-IRIs mit Score und Label.',
    input: z.object({
        query: z.string().min(1).max(2000).describe('Suchtext'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximale Treffer (Default 20)'),
        vector: z.boolean().optional().describe('Zusätzlich Vektorähnlichkeit (nur mit konfigurierten Embeddings)'),
    }),
    effect: 'read',
    target: { kind: 'dataset' },
    async run(input, ctx) {
        return mcpSearch(graphContextOf(ctx, { vector: input.vector }), input);
    },
});

export const graphRetrieve = defineAction({
    name: 'graph_retrieve',
    title: 'Multi-Hop-Retrieval',
    description:
        'Retrieval nach GRAPH_CORE_SPEC §7.5: Seeding (IRI/Volltext/Vektor), Expansion über bis zu 4 Hops, ' +
        'deterministisches Scoring, linearisierter Kontext. Antwort enthält immer explain und provenance. ' +
        'Mit `causal` folgt die Auswahl einem Kausalmodell statt der semantischen Nachbarschaft.',
    input: retrieveInputSchema,
    effect: 'read',
    target: { kind: 'dataset' },
    async run(input, ctx) {
        const { profile: profileId, ...overrides } = input;
        let request: RetrievalRequestInput = overrides;
        if (profileId) {
            const profile = await getRetrievalProfile(ctx.graph, profileId);
            if (!profile) throw notFound(`Retrieval-Profil "${profileId}" existiert nicht.`);
            request = { ...profile.config, ...overrides };
        }
        // Vektoren nur, wenn das Seeding sie braucht — der Index kostet
        // Embedding-Aufrufe über das ganze Dataset.
        const needsVector = Boolean(request.seeds?.vector?.length) || Boolean(request.seeds?.text);
        const graphCtx = graphContextOf(ctx, { vector: needsVector });
        if (request.seeds?.vector?.length && ctx.retrieval) {
            const probe = await ctx.retrieval([], { vector: true });
            if (!probe.vector) {
                // Roh-Vektor ohne Index: ehrlicher Fehler statt leerem Ergebnis.
                throw new ActionError(400, `Vektor-Seeding nicht verfügbar: ${probe.embeddings?.reason ?? 'keine Embeddings konfiguriert'}`);
            }
        }
        // Default `format: 'context'` laut §7.6 — eine ausdrückliche Angabe
        // des Aufrufers (oder des Profils) gewinnt.
        return mcpRetrieve(graphCtx, { ...request, format: request.format ?? 'context' });
    },
});

export const graphNeighbors = defineAction({
    name: 'graph_neighbors',
    title: 'Direkte Nachbarschaft',
    description: 'Ein Hop um einen Knoten — günstig. Liefert Prädikat, Richtung, Quell-Graph und Label je Nachbar.',
    input: z.object({
        iri: z.string().min(1).describe('IRI des Knotens'),
        direction: z.enum(['out', 'in', 'both']).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        includeInferred: z.boolean().optional(),
    }),
    effect: 'read',
    target: { kind: 'dataset' },
    async run(input, ctx) {
        return mcpNeighbors(graphContextOf(ctx), input);
    },
});

export const graphDescribe = defineAction({
    name: 'graph_describe',
    title: 'Alle Aussagen über eine IRI',
    description: 'Aussagen über einen Knoten als Turtle plus strukturierte Liste, mit Provenienz je Quell-Graph.',
    input: z.object({
        iri: z.string().min(1).describe('IRI des Knotens'),
        includeInferred: z.boolean().optional(),
    }),
    effect: 'read',
    target: { kind: 'dataset' },
    async run(input, ctx) {
        return mcpDescribe(graphContextOf(ctx), input);
    },
});

export const graphSparql = defineAction({
    name: 'graph_sparql',
    title: 'SPARQL (read-only)',
    description: 'Rohe SPARQL-1.1-Query gegen das erlaubte Dataset. SELECT/ASK/CONSTRUCT/DESCRIBE — keine Updates.',
    input: z.object({
        query: z.string().min(1).max(100_000),
        format: z.enum(['json', 'csv', 'turtle', 'json-ld']).optional().describe('Default: json'),
    }),
    effect: 'read',
    target: { kind: 'sparql' },
    async run(input, ctx) {
        const result = await mcpSparql(graphContextOf(ctx), input);
        if (result.status >= 400) throw new ActionError(result.status, result.body.trim());
        return result;
    },
});

export const graphWrite = defineAction({
    name: 'graph_write',
    title: 'In den freigegebenen Graphen schreiben',
    description:
        'Hängt RDF an den für diesen Zugang freigegebenen Graphen an. Jedes geschriebene Subjekt bekommt ' +
        'prov:wasAttributedTo auf den aufrufenden Agenten. Kein anderer Graph ist erreichbar.',
    input: z.object({
        rdf: z.string().min(1).max(1_000_000).describe('RDF-Rumpf'),
        format: z.enum(['text/turtle', 'application/ld+json', 'application/n-triples']).optional()
            .describe('Default: text/turtle'),
    }),
    effect: 'constructive',
    target: { kind: 'grant-write' },
    changes: [OW.Document, OW.Task, OW.Project],
    async run(input, ctx) {
        try {
            return await mcpWrite(graphContextOf(ctx), input);
        } catch (error) {
            if (error instanceof McpWriteDeniedError) throw new ActionError(422, error.message);
            throw error;
        }
    },
});

/** Reihenfolge = Tabelle in SPEC §7.6. */
export const GRAPH_ACTIONS = [graphSearch, graphRetrieve, graphNeighbors, graphDescribe, graphSparql, graphWrite] as const;

registerActions('graph/mcp', [...GRAPH_ACTIONS]);
