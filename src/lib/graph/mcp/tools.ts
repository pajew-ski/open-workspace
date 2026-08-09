/**
 * Werkzeuge des MCP-Servers (SPEC §7.6, M10) — die Graph-Operationen
 * hinter `/api/mcp`, transportfrei und einzeln testbar.
 *
 * Jede Operation arbeitet gegen das erlaubte Dataset des Aufrufers. Das
 * ist kein zweiter Authz-Pfad: `retrievalDataset` und
 * `executeSparqlProtocol` sind dieselben Funktionen, die Retrieval-API und
 * SPARQL-Endpoint benutzen — der Grant (§7.6) verengt sie lediglich. Die
 * Klammer greift VOR jeder Expansion, damit ein gesperrter Graph auch
 * über mehrere Hops unerreichbar bleibt.
 */

import type { Quad, Term } from '@rdfjs/types';
import type { AccessGrant } from '../authz/grant';
import { factory, literal, namedNode, typedLiteral } from '../rdf';
import { OW, RDF } from '../vocab';
import { parseRdf, serializeRdf } from '../serialize/io';
import { executeSparqlProtocol } from '../sparql/protocol';
import { classifySparql } from '../sparql/classify';
import { newViolations, validateQuads } from '../reasoning/shacl';
import {
    retrievalDataset,
    retrieve,
    type GraphHandle,
    type RetrievalDeps,
    type RetrievalRequestInput,
    type RetrievalResult,
} from '../search/retrieval';
import { FulltextIndex } from '../search/fulltext';
import { PROV, SCHEMA, SKOS, PREFIXES } from '../vocab';

export interface McpGraphContext {
    handle: GraphHandle;
    grant: AccessGrant;
    /**
     * Seed-Quellen für ein konkretes Dataset (Volltext Pflicht, Vektor
     * optional). Die Route injiziert den Index-Cache aus M8; Tests einen
     * frisch gebauten Index.
     */
    retrievalDeps?: (dataset: readonly string[]) => Promise<RetrievalDeps>;
    /** Uhr für PROV-Zeitstempel (Tests: deterministisch). */
    now?: () => Date;
    /**
     * Nachbereitung eines Schreibvorgangs (Snapshot, Index-Invalidierung).
     * Die Route injiziert sie; Tests dürfen sie weglassen.
     */
    afterWrite?: () => Promise<void>;
}

/** Harte Obergrenzen der günstigen Werkzeuge. */
const MAX_SEARCH_LIMIT = 100;
const MAX_NEIGHBORS = 200;
const MAX_DESCRIBE_QUADS = 2000;
const MAX_WRITE_QUADS = 5000;

const LABEL_PREDICATES: readonly string[] = [
    SCHEMA.name,
    SKOS.prefLabel,
    `${PREFIXES.rdfs}label`,
    `${PREFIXES.dcterms}title`,
];

/** Erlaubtes Dataset dieses Aufrufers (Grant-verengt). */
export async function datasetFor(
    ctx: McpGraphContext,
    options: { includeInferred?: boolean; graphs?: string[] } = {},
): Promise<string[]> {
    return retrievalDataset(ctx.handle, {
        includeInferred: options.includeInferred ?? false,
        ...(options.graphs ? { graphs: options.graphs } : {}),
        allowedGraphs: ctx.grant.readableGraphs,
    });
}

async function selectRows(
    ctx: McpGraphContext,
    sparql: string,
    dataset: readonly string[],
): Promise<Array<Record<string, Term>>> {
    const graphs = dataset.map(namedNode);
    const result = await ctx.handle.store.query(sparql, {
        defaultGraphs: graphs,
        namedGraphs: graphs,
        timeoutMs: 20_000,
    });
    if (result.type !== 'bindings') return [];
    const rows: Array<Record<string, Term>> = [];
    for await (const row of result.bindings) rows.push(row);
    return rows;
}

function iriRef(iri: string): string {
    return `<${iri.replace(/[<>"{}|^`\\\s]/g, encodeURIComponent)}>`;
}

// --- graph_search --------------------------------------------------------

export interface McpSearchHit {
    iri: string;
    score: number;
    label: string | null;
    graphs: string[];
}

export interface McpSearchResult {
    query: string;
    hits: McpSearchHit[];
    vectorHits: Array<{ iri: string; similarity: number; graph: string }>;
    /** Ehrliche Auskunft, wenn Embeddings nicht konfiguriert sind. */
    notes: string[];
    indexedLiterals: number;
}

export async function mcpSearch(
    ctx: McpGraphContext,
    input: { query: string; limit?: number; vector?: boolean },
): Promise<McpSearchResult> {
    const dataset = await datasetFor(ctx);
    const limit = Math.min(Math.max(input.limit ?? 20, 1), MAX_SEARCH_LIMIT);
    const deps = await (ctx.retrievalDeps?.(dataset) ?? Promise.resolve<RetrievalDeps>({}));
    const notes: string[] = [];
    const index = deps.fulltext ?? await buildFallbackIndex(ctx, dataset);
    const hits = index.search(input.query, { limit, graphs: dataset });

    let vectorHits: McpSearchResult['vectorHits'] = [];
    if (input.vector) {
        if (deps.vector && deps.embedQuery) {
            const vector = await deps.embedQuery(input.query);
            vectorHits = deps.vector.search(vector, { limit, graphs: dataset });
        } else {
            notes.push('Vektorsuche nicht verfügbar — es sind keine Embeddings konfiguriert.');
        }
    }
    return {
        query: input.query,
        hits: hits.map(hit => ({
            iri: hit.iri,
            score: hit.score,
            label: hit.label ?? null,
            graphs: hit.graphs,
        })),
        vectorHits,
        notes,
        indexedLiterals: index.size,
    };
}

async function buildFallbackIndex(ctx: McpGraphContext, dataset: readonly string[]): Promise<FulltextIndex> {
    const quads: Quad[] = [];
    for (const graph of dataset) {
        for await (const q of ctx.handle.store.dump(namedNode(graph))) quads.push(q);
    }
    return FulltextIndex.fromQuads(quads);
}

// --- graph_retrieve ------------------------------------------------------

export async function mcpRetrieve(
    ctx: McpGraphContext,
    input: RetrievalRequestInput,
): Promise<RetrievalResult> {
    const dataset = await datasetFor(ctx, {
        includeInferred: input.includeInferred ?? false,
        ...(input.graphs ? { graphs: input.graphs } : {}),
    });
    const deps = await (ctx.retrievalDeps?.(dataset) ?? Promise.resolve<RetrievalDeps>({}));
    return retrieve(ctx.handle, input, deps, { allowedGraphs: ctx.grant.readableGraphs });
}

// --- graph_neighbors -----------------------------------------------------

export interface McpNeighbor {
    iri: string;
    predicate: string;
    direction: 'out' | 'in';
    graph: string;
    label: string | null;
}

export interface McpNeighborsResult {
    iri: string;
    neighbors: McpNeighbor[];
    truncated: boolean;
    /** Graphen, in denen der Knoten überhaupt vorkommt (Provenienz). */
    sourceGraphs: string[];
}

export async function mcpNeighbors(
    ctx: McpGraphContext,
    input: { iri: string; direction?: 'out' | 'in' | 'both'; limit?: number; includeInferred?: boolean },
): Promise<McpNeighborsResult> {
    const dataset = await datasetFor(ctx, { includeInferred: input.includeInferred ?? false });
    const direction = input.direction ?? 'both';
    const limit = Math.min(Math.max(input.limit ?? 50, 1), MAX_NEIGHBORS);
    const neighbors: McpNeighbor[] = [];
    if (dataset.length === 0) {
        return { iri: input.iri, neighbors: [], truncated: false, sourceGraphs: [] };
    }

    const queries: Array<{ sparql: string; direction: 'out' | 'in' }> = [];
    if (direction === 'out' || direction === 'both') {
        queries.push({
            direction: 'out',
            sparql: `SELECT ?p ?n ?g WHERE { GRAPH ?g { ${iriRef(input.iri)} ?p ?n } FILTER(isIRI(?n)) }`,
        });
    }
    if (direction === 'in' || direction === 'both') {
        queries.push({
            direction: 'in',
            sparql: `SELECT ?p ?n ?g WHERE { GRAPH ?g { ?n ?p ${iriRef(input.iri)} } FILTER(isIRI(?n)) }`,
        });
    }
    const seen = new Set<string>();
    for (const query of queries) {
        for (const row of await selectRows(ctx, query.sparql, dataset)) {
            if (row.p?.termType !== 'NamedNode' || row.n?.termType !== 'NamedNode' || row.g?.termType !== 'NamedNode') continue;
            const key = `${query.direction}\n${row.p.value}\n${row.n.value}\n${row.g.value}`;
            if (seen.has(key)) continue;
            seen.add(key);
            neighbors.push({ iri: row.n.value, predicate: row.p.value, direction: query.direction, graph: row.g.value, label: null });
        }
    }
    neighbors.sort((a, b) =>
        a.direction.localeCompare(b.direction) ||
        a.predicate.localeCompare(b.predicate) ||
        a.iri.localeCompare(b.iri) ||
        a.graph.localeCompare(b.graph));
    const truncated = neighbors.length > limit;
    const page = neighbors.slice(0, limit);
    await attachLabels(ctx, dataset, page);

    const sourceGraphs = [...new Set(
        (await selectRows(ctx, `SELECT DISTINCT ?g WHERE { GRAPH ?g { ${iriRef(input.iri)} ?p ?o } }`, dataset))
            .map(row => row.g?.value)
            .filter((v): v is string => typeof v === 'string'),
    )].sort();

    return { iri: input.iri, neighbors: page, truncated, sourceGraphs };
}

async function attachLabels(ctx: McpGraphContext, dataset: readonly string[], neighbors: McpNeighbor[]): Promise<void> {
    const iris = [...new Set(neighbors.map(n => n.iri))].sort();
    if (iris.length === 0) return;
    const values = iris.map(iriRef).join(' ');
    const rows = await selectRows(
        ctx,
        `SELECT ?n ?p ?l WHERE { VALUES ?n { ${values} } GRAPH ?g { ?n ?p ?l } FILTER(isLiteral(?l)) }`,
        dataset,
    );
    const labels = new Map<string, string>();
    rows.sort((a, b) => (a.n?.value ?? '').localeCompare(b.n?.value ?? '') || (a.p?.value ?? '').localeCompare(b.p?.value ?? ''));
    for (const row of rows) {
        if (row.n?.termType !== 'NamedNode' || row.p?.termType !== 'NamedNode') continue;
        if (!LABEL_PREDICATES.includes(row.p.value)) continue;
        if (!labels.has(row.n.value)) labels.set(row.n.value, row.l?.value ?? '');
    }
    for (const neighbor of neighbors) {
        neighbor.label = labels.get(neighbor.iri) ?? null;
    }
}

// --- graph_describe ------------------------------------------------------

export interface McpDescribeResult {
    iri: string;
    /** Turtle-Serialisierung der Aussagen ÜBER die IRI. */
    turtle: string;
    statements: Array<{ predicate: string; object: string; objectType: 'iri' | 'literal' | 'bnode'; graph: string }>;
    provenance: Array<{ graph: string; connector?: string; inferred: boolean; statements: number }>;
    truncated: boolean;
    found: boolean;
}

export async function mcpDescribe(
    ctx: McpGraphContext,
    input: { iri: string; includeInferred?: boolean },
): Promise<McpDescribeResult> {
    const dataset = await datasetFor(ctx, { includeInferred: input.includeInferred ?? false });
    const rows = dataset.length === 0
        ? []
        : await selectRows(ctx, `SELECT ?p ?o ?g WHERE { GRAPH ?g { ${iriRef(input.iri)} ?p ?o } }`, dataset);

    const statements: McpDescribeResult['statements'] = [];
    const quads: Quad[] = [];
    const byGraph = new Map<string, number>();
    for (const row of rows) {
        if (row.p?.termType !== 'NamedNode' || row.g?.termType !== 'NamedNode' || !row.o) continue;
        statements.push({
            predicate: row.p.value,
            object: row.o.value,
            objectType: row.o.termType === 'NamedNode' ? 'iri' : row.o.termType === 'BlankNode' ? 'bnode' : 'literal',
            graph: row.g.value,
        });
        byGraph.set(row.g.value, (byGraph.get(row.g.value) ?? 0) + 1);
    }
    statements.sort((a, b) => a.predicate.localeCompare(b.predicate) || a.object.localeCompare(b.object) || a.graph.localeCompare(b.graph));
    const truncated = statements.length > MAX_DESCRIBE_QUADS;
    const page = truncated ? statements.slice(0, MAX_DESCRIBE_QUADS) : statements;

    // Turtle aus den tatsächlichen Termen (Datentypen/Sprachen erhalten).
    const subject = namedNode(input.iri);
    for (const row of rows.slice(0, MAX_DESCRIBE_QUADS)) {
        if (row.p?.termType !== 'NamedNode' || !row.o) continue;
        if (row.o.termType !== 'NamedNode' && row.o.termType !== 'Literal' && row.o.termType !== 'BlankNode') continue;
        quads.push(factory.quad(subject, row.p, row.o));
    }

    const importPrefix = ctx.handle.iri.importGraph('');
    const provenance = [...byGraph.entries()]
        .map(([graph, count]) => ({
            graph,
            ...(graph.startsWith(importPrefix)
                ? { connector: decodeURIComponent(graph.slice(importPrefix.length)) }
                : {}),
            inferred: graph.includes('/inferred/'),
            statements: count,
        }))
        .sort((a, b) => a.graph.localeCompare(b.graph));

    return {
        iri: input.iri,
        turtle: quads.length > 0 ? serializeRdf(quads, 'text/turtle') : '',
        statements: page,
        provenance,
        truncated,
        found: statements.length > 0,
    };
}

// --- graph_sparql --------------------------------------------------------

export interface McpSparqlResult {
    status: number;
    contentType: string;
    body: string;
}

const SPARQL_ACCEPT: Record<string, string> = {
    json: 'application/sparql-results+json',
    csv: 'text/csv',
    turtle: 'text/turtle',
    'json-ld': 'application/ld+json',
};

export async function mcpSparql(
    ctx: McpGraphContext,
    input: { query: string; format?: keyof typeof SPARQL_ACCEPT },
): Promise<McpSparqlResult> {
    if (!ctx.grant.sparql) {
        return {
            status: 403,
            contentType: 'text/plain; charset=utf-8',
            body: 'Dieses Token hat kein Recht auf rohe SPARQL-Queries ("sparql": true fehlt).\n',
        };
    }
    const operation = classifySparql(input.query);
    if (operation === 'update') {
        return {
            status: 405,
            contentType: 'text/plain; charset=utf-8',
            body: 'graph_sparql ist read-only — Updates laufen über graph_write.\n',
        };
    }
    // CONSTRUCT/DESCRIBE liefern Quads: dort sind nur die Graph-Formate
    // verhandelbar — eine Tabellen-Anforderung fällt auf Turtle zurück.
    const requested = SPARQL_ACCEPT[input.format ?? 'json'] ?? SPARQL_ACCEPT.json;
    const quadsShaped = operation === 'construct' || operation === 'describe';
    const accept = quadsShaped
        ? (requested === SPARQL_ACCEPT['json-ld'] ? requested : SPARQL_ACCEPT.turtle)
        : requested;
    return executeSparqlProtocol(
        ctx.handle.store,
        ctx.handle.iri,
        {
            method: 'POST',
            contentType: 'application/sparql-query',
            accept,
            body: input.query,
        },
        { allowedGraphs: ctx.grant.readableGraphs, readOnly: true },
    );
}

// --- graph_write (Default aus, SPEC §7.6) --------------------------------

export interface McpWriteResult {
    graph: string;
    added: number;
    activity: string;
    agent: string;
}

export class McpWriteDeniedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'McpWriteDeniedError';
    }
}

/**
 * Schreibt ausschließlich in den freigegebenen Graphen des Tokens, immer
 * mit `prov:wasAttributedTo` auf den aufrufenden Agenten (SPEC §7.6).
 * Angehängt, nicht ersetzt: der Graph gehört nicht dem einzelnen Aufruf.
 */
export async function mcpWrite(
    ctx: McpGraphContext,
    input: { rdf: string; format?: string },
): Promise<McpWriteResult> {
    const target = ctx.grant.writableGraph;
    if (!target) {
        throw new McpWriteDeniedError('graph_write ist für dieses Token nicht freigegeben.');
    }
    const format = input.format && input.format.trim() !== '' ? input.format : 'text/turtle';
    let parsed: Quad[];
    try {
        parsed = parseRdf(input.rdf, { format, baseIri: ctx.handle.iri.instanceBase });
    } catch (error) {
        throw new McpWriteDeniedError(`RDF nicht lesbar (${format}): ${error instanceof Error ? error.message : String(error)}`);
    }
    if (parsed.length === 0) {
        throw new McpWriteDeniedError('Keine Tripel im Rumpf — nichts zu schreiben.');
    }
    if (parsed.length > MAX_WRITE_QUADS) {
        throw new McpWriteDeniedError(`Zu viele Tripel (${parsed.length} > ${MAX_WRITE_QUADS}).`);
    }

    const now = (ctx.now ?? (() => new Date()))();
    const stamp = now.toISOString();
    const agentIri = ctx.handle.iri.entity('agent', `mcp-${ctx.grant.identity}`);
    const activityIri = ctx.handle.iri.entity('activity', `mcp-write-${ctx.grant.identity}-${stamp}`);
    const graph = namedNode(target);

    const provQuads: Quad[] = [
        factory.quad(namedNode(agentIri), namedNode(RDF.type), namedNode(PROV.SoftwareAgent), graph),
        factory.quad(namedNode(agentIri), namedNode(RDF.type), namedNode(OW.Agent), graph),
        factory.quad(namedNode(agentIri), namedNode(SCHEMA.name), literal(`MCP-Token „${ctx.grant.identity}"`), graph),
        factory.quad(namedNode(activityIri), namedNode(RDF.type), namedNode(PROV.Activity), graph),
        factory.quad(namedNode(activityIri), namedNode(PROV.wasAttributedTo), namedNode(agentIri), graph),
        factory.quad(namedNode(activityIri), namedNode(PROV.endedAtTime), typedLiteral.dateTime(stamp), graph),
        factory.quad(namedNode(activityIri), namedNode(SCHEMA.name), literal(`MCP-Schreibvorgang (${ctx.grant.identity})`), graph),
    ];
    // Provenienz pro geschriebenem Subjekt: wer hat es beigetragen.
    const subjects = [...new Set(parsed.map(q => q.subject.value))].sort();
    for (const subjectValue of subjects) {
        const subject = parsed.find(q => q.subject.value === subjectValue)!.subject;
        provQuads.push(factory.quad(subject, namedNode(PROV.wasAttributedTo), namedNode(agentIri), graph));
        provQuads.push(factory.quad(subject, namedNode(PROV.wasGeneratedBy), namedNode(activityIri), graph));
    }

    // Lesen, validieren und schreiben laufen in EINER Transaktion: sonst
    // könnte zwischen Bestandsaufnahme und Replace eine fremde Mutation
    // verloren gehen — und eine SHACL-Verletzung wäre schon geschrieben,
    // bevor sie auffällt.
    const added = await ctx.handle.store.transaction(async tx => {
        const existing: Quad[] = [];
        for await (const q of tx.dump(graph)) existing.push(q);
        const next = [...existing, ...parsed, ...provQuads];

        // SHACL vor dem Schreibvorgang (SPEC §7.2, erste der drei Stellen —
        // dieselbe Regel wie in workspace/crud.ts: blockierend nur für
        // Verletzungen, die DIESE Mutation neu einführt).
        const shapes: Quad[] = [];
        for await (const q of tx.dump(namedNode(ctx.handle.iri.sharedGraph('shapes')))) shapes.push(q);
        if (shapes.length > 0) {
            const fresh = newViolations(
                await validateQuads(shapes, existing),
                await validateQuads(shapes, next),
            );
            if (fresh.length > 0) {
                throw new McpWriteDeniedError(
                    `SHACL-Verletzung: ${fresh.map(v => `${v.message} (${v.focusNode})`).join('; ')}`,
                );
            }
        }

        const report = await tx.load(next, graph, { replace: true });
        return Math.max(0, report.added - existing.length);
    });
    await ctx.afterWrite?.();
    return { graph: target, added, activity: activityIri, agent: agentIri };
}

// --- Resources: graph://<iri> --------------------------------------------

export interface McpResourceRepresentation {
    uri: string;
    mimeType: string;
    text: string;
}

/**
 * Resource-URI eines Knotens (SPEC §7.6: `graph://<iri>`). Die IRI wird
 * prozentkodiert eingebettet — nur so ist die URI für jede Instanz-Base
 * eine gültige URL (`urn:ow:…` und `https://…` tragen beide Zeichen, die
 * in der Autoritätskomponente sonst als Port oder Pfad gelesen würden).
 */
export function graphResourceUri(iri: string): string {
    return `graph://${encodeURIComponent(iri)}`;
}

/**
 * Ein Knoten als MCP-Resource (SPEC §7.6): Turtle und JSON-LD, damit
 * Clients Kontext referenzieren statt kopieren. Außerhalb des erlaubten
 * Datasets ist die Antwort leer — keine Existenzbestätigung.
 */
export async function readGraphResource(
    ctx: McpGraphContext,
    iri: string,
): Promise<McpResourceRepresentation[]> {
    const described = await mcpDescribe(ctx, { iri });
    const uri = graphResourceUri(iri);
    if (!described.found) return [];
    const jsonld: Record<string, unknown> = { '@id': iri };
    for (const statement of described.statements) {
        const key = statement.predicate;
        const value = statement.objectType === 'iri' ? { '@id': statement.object } : statement.object;
        const current = jsonld[key];
        if (current === undefined) jsonld[key] = value;
        else if (Array.isArray(current)) current.push(value);
        else jsonld[key] = [current, value];
    }
    return [
        { uri, mimeType: 'text/turtle', text: described.turtle },
        { uri, mimeType: 'application/ld+json', text: `${JSON.stringify(jsonld, null, 2)}\n` },
    ];
}

/** Kandidaten für `resources/list` — typisierte Knoten des Datasets. */
export async function listGraphResources(
    ctx: McpGraphContext,
    limit = 50,
): Promise<Array<{ uri: string; name: string; description: string }>> {
    const dataset = await datasetFor(ctx);
    if (dataset.length === 0) return [];
    const rows = await selectRows(
        ctx,
        `SELECT DISTINCT ?s ?l WHERE {
            GRAPH ?g { ?s <${RDF.type}> ?t }
            OPTIONAL { GRAPH ?g2 { ?s <${SCHEMA.name}> ?l } }
            FILTER(isIRI(?s))
        } LIMIT ${Math.min(Math.max(limit, 1), 500)}`,
        dataset,
    );
    const seen = new Map<string, string>();
    for (const row of rows) {
        if (row.s?.termType !== 'NamedNode') continue;
        if (!seen.has(row.s.value)) seen.set(row.s.value, row.l?.value ?? row.s.value);
    }
    return [...seen.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([iri, label]) => ({
            uri: graphResourceUri(iri),
            name: label,
            description: `Knoten ${iri} als Turtle und JSON-LD.`,
        }));
}
