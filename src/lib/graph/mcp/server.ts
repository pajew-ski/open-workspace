/**
 * MCP-Server des Graphen (SPEC §7.6, M10).
 *
 * Der Workspace war bisher MCP-**Client** (`src/lib/ai/mcp/client.ts`);
 * hier wird er zusätzlich MCP-**Server**, damit externe Agenten auf dem
 * Graphen retrieven können, ohne SPARQL zu sprechen. Dieselbe SDK, die
 * schon den Client trägt — kein zweites Protokoll-Framework.
 *
 * Angeboten werden die sechs Werkzeuge aus §7.6, Knoten als Resources
 * (`graph://<iri>`, Turtle + JSON-LD) und die gespeicherten
 * Retrieval-Profile (M8) als Prompts. Der Server wird PRO ANFRAGE über
 * den Grant des Tokens gebaut: ein Client sieht nur, was sein Token darf —
 * `graph_sparql` verschwindet ohne SPARQL-Recht, `graph_write` ohne
 * Schreibfreigabe. Kein totes Werkzeug im Inventar (Invariante 10).
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listRetrievalProfiles } from '../search/profiles';
import type { RetrievalRequestInput } from '../search/retrieval';
import {
    listGraphResources,
    mcpDescribe,
    mcpNeighbors,
    mcpRetrieve,
    mcpSearch,
    mcpSparql,
    mcpWrite,
    McpWriteDeniedError,
    readGraphResource,
    type McpGraphContext,
} from './tools';
import { MCP_TOOL_TIMEOUT_MS, withTimeout } from './limits';

export const MCP_SERVER_INFO = {
    name: 'open-workspace-graph',
    version: '1.0.0',
    title: 'Open Workspace — Graph',
} as const;

/** Namen der Werkzeuge aus SPEC §7.6 (Reihenfolge = Tabelle der Spec). */
export const MCP_TOOL_NAMES = [
    'graph_search',
    'graph_retrieve',
    'graph_neighbors',
    'graph_describe',
    'graph_sparql',
    'graph_write',
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/** Welche Werkzeuge dieses Token tatsächlich sieht (Status-UI + Tests). */
export function toolsForGrant(grant: McpGraphContext['grant']): McpToolName[] {
    const tools: McpToolName[] = ['graph_search', 'graph_retrieve', 'graph_neighbors', 'graph_describe'];
    if (grant.sparql) tools.push('graph_sparql');
    if (grant.writableGraph) tools.push('graph_write');
    return tools;
}

function jsonResult(payload: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message: string) {
    return { content: [{ type: 'text' as const, text: message }], isError: true };
}

const typeFilterShape = z.object({
    include: z.array(z.string()).max(50).optional(),
    exclude: z.array(z.string()).max(50).optional(),
}).optional();

export function createGraphMcpServer(ctx: McpGraphContext): McpServer {
    const server = new McpServer(MCP_SERVER_INFO, {
        capabilities: { tools: {}, resources: {}, prompts: {} },
        instructions:
            'Wissensgraph des Open Workspace. graph_search findet Einstiegsknoten, ' +
            'graph_retrieve liefert Multi-Hop-Kontext mit Provenienz und Erklärung, ' +
            'graph_neighbors und graph_describe sind die günstigen Einzelabfragen. ' +
            'Knoten sind als Resource graph://<iri> referenzierbar. Es ist immer nur ' +
            'der Teil des Graphen sichtbar, den das benutzte Token lesen darf.',
    });

    server.registerTool('graph_search', {
        title: 'Graph durchsuchen',
        description: 'Volltext- (und optional Vektor-)Suche über alle Literale. Liefert Kandidaten-IRIs mit Score und Label.',
        annotations: { readOnlyHint: true },
        inputSchema: {
            query: z.string().min(1).max(2000).describe('Suchtext'),
            limit: z.number().int().min(1).max(100).optional().describe('Maximale Treffer (Default 20)'),
            vector: z.boolean().optional().describe('Zusätzlich Vektorähnlichkeit (nur mit konfigurierten Embeddings)'),
        },
    }, async args => {
        const result = await withTimeout('graph_search', MCP_TOOL_TIMEOUT_MS.graph_search, () => mcpSearch(ctx, args));
        return jsonResult(result);
    });

    server.registerTool('graph_retrieve', {
        title: 'Multi-Hop-Retrieval',
        description:
            'Retrieval nach SPEC §7.5: Seeding (IRI/Volltext/Vektor), Expansion über bis zu 4 Hops, ' +
            'deterministisches Scoring, linearisierter Kontext. Antwort enthält immer explain und provenance. ' +
            'Mit `causal` folgt die Auswahl einem Kausalmodell statt der semantischen Nachbarschaft: ' +
            'explain trägt dann den kausalen Pfad, und was gegeben blockedBy d-separiert ist, fehlt begründet.',
        annotations: { readOnlyHint: true },
        inputSchema: {
            seeds: z.object({
                iri: z.array(z.string()).max(100).optional(),
                text: z.string().max(2000).optional(),
                vector: z.array(z.number()).max(8192).optional(),
            }).optional(),
            maxHops: z.number().int().min(1).max(4).optional(),
            maxNodes: z.number().int().min(1).max(500).optional(),
            edgeTypes: typeFilterShape,
            nodeTypes: typeFilterShape,
            direction: z.enum(['out', 'in', 'both']).optional(),
            graphs: z.array(z.string()).max(50).optional(),
            decay: z.number().min(0).max(1).optional(),
            maxDegree: z.number().int().min(1).max(10_000).optional(),
            includeInferred: z.boolean().optional(),
            format: z.enum(['subgraph', 'context', 'both']).optional().describe('Default: context'),
            tokenBudget: z.number().int().min(50).max(100_000).optional(),
            seedLimit: z.number().int().min(1).max(100).optional(),
            profile: z.string().max(200).optional().describe('ID eines gespeicherten Retrieval-Profils als Basis'),
            causal: z.object({
                mode: z.enum(['ancestors', 'descendants', 'paths', 'markov-blanket'])
                    .describe('ancestors = Ursachenseite, descendants = Folgenseite, paths = Wege, markov-blanket = Kragen'),
                treatment: z.string().max(2000).optional().describe('IRI der Ursache'),
                outcome: z.string().max(2000).optional().describe('IRI der Wirkung'),
                model: z.string().max(2000).optional().describe('Kennung oder IRI des Kausalmodells (Default: das einzige)'),
                blockedBy: z.array(z.string().max(2000)).max(50).optional()
                    .describe('Konditionierungsmenge — d-separierte Größen fallen aus dem Kontext'),
                minEvidence: z.enum(['hypothesis', 'estimated', 'refuted-clean']).optional()
                    .describe('Mindest-Belegstand je Kante; geschätzte Kanten gibt es erst mit C4'),
            }).optional().describe('Kausale Erdung nach CAUSAL_LAYER_SPEC §9'),
        },
    }, async args => {
        const { profile: profileId, ...overrides } = args;
        let input: RetrievalRequestInput = overrides;
        if (profileId) {
            const profiles = await listRetrievalProfiles(ctx.handle);
            const profile = profiles.find(p => p.id === profileId);
            if (!profile) return errorResult(`Retrieval-Profil "${profileId}" existiert nicht.`);
            input = { ...profile.config, ...overrides };
        }
        // Default `format: 'context'` laut §7.6 — eine ausdrückliche
        // Angabe des Aufrufers (oder des Profils) gewinnt.
        const request: RetrievalRequestInput = { ...input, format: input.format ?? 'context' };
        const result = await withTimeout('graph_retrieve', MCP_TOOL_TIMEOUT_MS.graph_retrieve, () =>
            mcpRetrieve(ctx, request));
        return jsonResult(result);
    });

    server.registerTool('graph_neighbors', {
        title: 'Direkte Nachbarschaft',
        description: 'Ein Hop um einen Knoten — günstig. Liefert Prädikat, Richtung, Quell-Graph und Label je Nachbar.',
        annotations: { readOnlyHint: true },
        inputSchema: {
            iri: z.string().min(1).describe('IRI des Knotens'),
            direction: z.enum(['out', 'in', 'both']).optional(),
            limit: z.number().int().min(1).max(200).optional(),
            includeInferred: z.boolean().optional(),
        },
    }, async args => {
        const result = await withTimeout('graph_neighbors', MCP_TOOL_TIMEOUT_MS.graph_neighbors, () => mcpNeighbors(ctx, args));
        return jsonResult(result);
    });

    server.registerTool('graph_describe', {
        title: 'Alle Aussagen über eine IRI',
        description: 'Aussagen über einen Knoten als Turtle plus strukturierte Liste, mit Provenienz je Quell-Graph.',
        annotations: { readOnlyHint: true },
        inputSchema: {
            iri: z.string().min(1).describe('IRI des Knotens'),
            includeInferred: z.boolean().optional(),
        },
    }, async args => {
        const result = await withTimeout('graph_describe', MCP_TOOL_TIMEOUT_MS.graph_describe, () => mcpDescribe(ctx, args));
        return jsonResult(result);
    });

    if (ctx.grant.sparql) {
        server.registerTool('graph_sparql', {
            title: 'SPARQL (read-only)',
            description: 'Rohe SPARQL-1.1-Query gegen das erlaubte Dataset. SELECT/ASK/CONSTRUCT/DESCRIBE — keine Updates.',
            annotations: { readOnlyHint: true },
            inputSchema: {
                query: z.string().min(1).max(100_000),
                format: z.enum(['json', 'csv', 'turtle', 'json-ld']).optional().describe('Default: json'),
            },
        }, async args => {
            const result = await withTimeout('graph_sparql', MCP_TOOL_TIMEOUT_MS.graph_sparql, () => mcpSparql(ctx, args));
            if (result.status >= 400) return errorResult(result.body.trim());
            return { content: [{ type: 'text' as const, text: result.body }] };
        });
    }

    if (ctx.grant.writableGraph) {
        server.registerTool('graph_write', {
            title: 'In den freigegebenen Graphen schreiben',
            description:
                `Hängt RDF an <${ctx.grant.writableGraph}> an. Jedes geschriebene Subjekt bekommt ` +
                'prov:wasAttributedTo auf den aufrufenden Agenten. Kein anderer Graph ist erreichbar.',
            annotations: { readOnlyHint: false, destructiveHint: false },
            inputSchema: {
                rdf: z.string().min(1).max(1_000_000).describe('RDF-Rumpf'),
                format: z.enum(['text/turtle', 'application/ld+json', 'application/n-triples']).optional()
                    .describe('Default: text/turtle'),
            },
        }, async args => {
            try {
                const result = await withTimeout('graph_write', MCP_TOOL_TIMEOUT_MS.graph_write, () => mcpWrite(ctx, args));
                return jsonResult(result);
            } catch (error) {
                if (error instanceof McpWriteDeniedError) return errorResult(error.message);
                throw error;
            }
        });
    }

    // --- Resources: Knoten als graph://<iri> ------------------------------
    server.registerResource(
        'graph-node',
        new ResourceTemplate('graph://{iri}', {
            list: async () => ({
                resources: (await listGraphResources(ctx)).map(entry => ({
                    uri: entry.uri,
                    name: entry.name,
                    description: entry.description,
                    mimeType: 'text/turtle',
                })),
            }),
        }),
        {
            title: 'Graph-Knoten',
            description: 'Ein Knoten des erlaubten Datasets als Turtle und JSON-LD.',
            mimeType: 'text/turtle',
        },
        async (uri, variables) => {
            const raw = variables.iri;
            const iri = decodeURIComponent(Array.isArray(raw) ? raw[0] ?? '' : raw ?? '');
            const contents = await withTimeout('resource', MCP_TOOL_TIMEOUT_MS.resource, () => readGraphResource(ctx, iri));
            if (contents.length === 0) {
                // Keine Existenzbestätigung: außerhalb des Datasets sieht
                // ein Knoten genauso aus wie ein nicht vorhandener.
                return { contents: [{ uri: uri.href, mimeType: 'text/turtle', text: '' }] };
            }
            return { contents };
        },
    );

    return server;
}

/**
 * Registriert die gespeicherten Retrieval-Profile (M8) als MCP-Prompts.
 * Getrennt vom Server-Bau, weil dafür der Store gelesen wird — der
 * Aufrufer entscheidet, ob er das pro Verbindung tun will.
 */
export async function registerRetrievalPrompts(server: McpServer, ctx: McpGraphContext): Promise<number> {
    const profiles = await listRetrievalProfiles(ctx.handle);
    for (const profile of profiles) {
        server.registerPrompt(`retrieval_${profile.id}`, {
            title: profile.name,
            description: profile.description ?? `Retrieval-Profil „${profile.name}" (${JSON.stringify(profile.config)}).`,
            argsSchema: { query: z.string().describe('Suchtext für das Seeding') },
        }, async ({ query }) => {
            const result = await withTimeout('graph_retrieve', MCP_TOOL_TIMEOUT_MS.graph_retrieve, () =>
                mcpRetrieve(ctx, { ...profile.config, format: 'context', seeds: { text: query } }));
            return {
                messages: [{
                    role: 'user' as const,
                    content: {
                        type: 'text' as const,
                        text: `Kontext aus dem Wissensgraphen (Profil „${profile.name}", Frage: ${query}):\n\n${result.context ?? '(kein Treffer)'}`,
                    },
                }],
            };
        });
    }
    return profiles.length;
}
