/**
 * Multi-Hop-Retrieval (SPEC §7.5, M8) — erstklassige API, keine ad-hoc-Query.
 *
 * Neuimplementierung des temet-nosce-Verfahrens gegen SPARQL und RDF 1.2
 * (Kantengewichte aus Reifier-Annotationen), NICHT als Portierung. Vier
 * Phasen, jede einzeln exportiert, testbar und parametrisierbar:
 *
 *   1. Seeding    — exakte IRIs, Volltexttreffer (§7.7), Vektorähnlichkeit
 *   2. Expansion  — BFS bis maxHops über das ERLAUBTE Dataset, mit
 *                   Kantentyp-/Knotentyp-Filtern, Richtung und Grad-Kappung
 *                   pro Knoten (Hub-Schutz)
 *   3. Scoring    — deterministisch und erklärbar: Seed-Score × Decay^Hop ×
 *                   Kantengewicht-Pfad × Zentralität × Aktualität
 *   4. Assembly   — Subgraph (Kanten-Hülle über den aufgenommenen Knoten)
 *                   plus linearisierter, zitierfähiger Kontext mit
 *                   Token-Budget-Kappung entlang der Score-Reihenfolge
 *
 * Verbindliche Eigenschaften (§7.5):
 *  - `explain` ist Pflicht: Seed-Strategie, genutzte Hops, Kappungen; jeder
 *    aufgenommene Knoten weist Hop, Herkunftskante (`via`) und seine
 *    Score-Bestandteile aus.
 *  - `provenance` pro Knoten: Quell-Graph und ggf. Connector — nativ,
 *    importiert und inferiert sind unterscheidbar.
 *  - Das Dataset ist IMMER das erlaubte (§17-Vorstufe wie resolveDataset):
 *    Wissens-Graphen des Nutzers (workspace, public, import/*, meta);
 *    presentation/acl/vocab/shapes sind nie Traversal-Raum, inferred/*
 *    nur bei `includeInferred: true`. Die Klammer greift VOR der
 *    Expansion (Dataset-Injektion), nie als Nachfilter.
 *  - Zyklenschutz (BFS-Besuchsmenge) und harte Obergrenzen für Knoten,
 *    Kanten und Laufzeit.
 *  - Aufgenommen wird nur, worüber im erlaubten Dataset etwas ausgesagt
 *    ist. Eine Kante, deren Ziel ausschließlich in einem gesperrten
 *    Graphen beschrieben ist, endet damit im Nichts — sie verrät weder
 *    Existenz noch Identität des Ziels (SPEC §7.6, Negativtest M10).
 *
 * Determinismus: gleiche Daten + gleiche Anfrage ⇒ identische Knotenmenge,
 * identische Score-Reihenfolge (Ties nach Hop, dann IRI). Alle
 * Fließkomma-Scores sind auf 6 Nachkommastellen gerundet.
 */

import type { Term } from '@rdfjs/types';
import type { GraphStore } from '../store/types';
import type { IriFactory } from '../iri';
import { namedNode } from '../rdf';
import { DCTERMS, OW, PREFIXES, PROV, RDF, SCHEMA, SKOS } from '../vocab';
import { workspaceScopeGraphs } from '../reasoning/run';
import { knowledgeGraphs } from '../authz/resolve';
import { FulltextIndex } from './fulltext';
import type { VectorIndex } from './vector';

export interface GraphHandle {
    store: GraphStore;
    iri: IriFactory;
}

// --- Anfrage- und Ergebnis-Typen (SPEC §7.5, wörtlich + Erklär-Felder) ---

export interface RetrievalSeeds {
    iri?: string[];
    text?: string;
    vector?: number[];
}

export interface RetrievalRequest {
    seeds?: RetrievalSeeds;
    /** 1..4, Default 2. */
    maxHops: number;
    /** Harte Knoten-Kappung, Default 50. */
    maxNodes: number;
    edgeTypes?: { include?: string[]; exclude?: string[] };
    nodeTypes?: { include?: string[]; exclude?: string[] };
    direction: 'out' | 'in' | 'both';
    /** Default: erlaubtes Dataset des Aufrufers (Wissens-Graphen). */
    graphs?: string[];
    /** Score-Abfall pro Hop, 0..1, Default 0.5. */
    decay: number;
    /** Grad-Kappung pro Knoten (Hub-Schutz), Default 100. */
    maxDegree?: number;
    /** Default false: Inferenz-Graphen nur auf Anforderung (M7). */
    includeInferred: boolean;
    format: 'subgraph' | 'context' | 'both';
    /** Token-Budget des linearisierten Kontexts (Default 4000). */
    tokenBudget?: number;
    /** Obergrenze der Text-/Vektor-Seeds (Ergänzung zu §7.5, Default 10). */
    seedLimit?: number;
}

export type RetrievalRequestInput = Partial<RetrievalRequest>;

export interface RetrievalScoreParts {
    /** Seed-Score des besten Pfads (1.0 für explizite IRIs). */
    seed: number;
    /** decay^hop des besten Pfads. */
    decay: number;
    /** Produkt der Kantengewichte des besten Pfads (Default 1). */
    edgeWeight: number;
    /** Zentralitätsfaktor aus dem Grad im Ergebnis-Subgraphen. */
    centrality: number;
    /** Aktualitätsfaktor aus dcterms:modified/created bzw. PROV. */
    recency: number;
}

export interface RetrievalNode {
    iri: string;
    score: number;
    hop: number;
    types: string[];
    label?: string;
    /** Seed-Quellen, falls der Knoten ein Seed war. */
    seed?: string[];
    /** Entdeckungs-Kante (Erklärbarkeit): von wo, über welches Prädikat. */
    via?: { from: string; predicate: string };
    scoreParts: RetrievalScoreParts;
}

export interface RetrievalEdge {
    s: string;
    p: string;
    o: string;
    graph: string;
    inferred: boolean;
}

export interface RetrievalProvenance {
    iri: string;
    sourceGraph: string;
    connector?: string;
}

export interface RetrievalExplain {
    seedStrategy: string;
    hopsUsed: number;
    /** Knoten, an denen die Grad-Kappung die Expansion gestoppt hat. */
    prunedAt?: string[];
    /** Ehrliche Hinweise (Kappungen, nicht verfügbare Seed-Quellen). */
    notes?: string[];
}

export interface RetrievalResult {
    nodes: RetrievalNode[];
    edges: RetrievalEdge[];
    /** Linearisiert und zitierfähig ([n]-Marken in Score-Reihenfolge). */
    context?: string;
    provenance: RetrievalProvenance[];
    truncated: boolean;
    explain: RetrievalExplain;
}

/**
 * Zugriffs-Klammer des Aufrufers (SPEC §7.6). Wird durchgereicht statt
 * neu erfunden: derselbe Grant, den auch der SPARQL-Pfad benutzt.
 */
export interface RetrievalAuthz {
    allowedGraphs?: readonly string[];
}

/** Injizierbare Seed-Quellen (Volltext Pflicht, Vektor optional). */
export interface RetrievalDeps {
    fulltext?: FulltextIndex;
    vector?: VectorIndex | null;
    /** Bettet den Query-Text ein (nur nötig für Text→Vektor-Seeding). */
    embedQuery?: (text: string) => Promise<number[]>;
    /** Uhr für das Laufzeit-Budget (Tests: deterministisch stellbar). */
    now?: () => number;
}

export const RETRIEVAL_DEFAULTS = {
    maxHops: 2,
    maxNodes: 50,
    direction: 'both',
    decay: 0.5,
    maxDegree: 100,
    includeInferred: false,
    format: 'both',
    tokenBudget: 4000,
    seedLimit: 10,
} as const satisfies Partial<RetrievalRequest>;

/** Harte Obergrenzen unabhängig von der Anfrage (§7.5: kein unbegrenztes Traversieren). */
const HARD_MAX_NODES = 500;
const HARD_MAX_EDGES = 5000;
const HARD_MAX_DURATION_MS = 15_000;

export function withRetrievalDefaults(input: RetrievalRequestInput): RetrievalRequest {
    const maxHops = clamp(Math.trunc(input.maxHops ?? RETRIEVAL_DEFAULTS.maxHops), 1, 4);
    const maxNodes = clamp(Math.trunc(input.maxNodes ?? RETRIEVAL_DEFAULTS.maxNodes), 1, HARD_MAX_NODES);
    return {
        seeds: input.seeds,
        maxHops,
        maxNodes,
        edgeTypes: input.edgeTypes,
        nodeTypes: input.nodeTypes,
        direction: input.direction ?? RETRIEVAL_DEFAULTS.direction,
        graphs: input.graphs,
        decay: clamp(input.decay ?? RETRIEVAL_DEFAULTS.decay, 0, 1),
        maxDegree: clamp(Math.trunc(input.maxDegree ?? RETRIEVAL_DEFAULTS.maxDegree), 1, 10_000),
        includeInferred: input.includeInferred ?? RETRIEVAL_DEFAULTS.includeInferred,
        format: input.format ?? RETRIEVAL_DEFAULTS.format,
        tokenBudget: input.tokenBudget !== undefined
            ? clamp(Math.trunc(input.tokenBudget), 50, 100_000)
            : RETRIEVAL_DEFAULTS.tokenBudget,
        seedLimit: clamp(Math.trunc(input.seedLimit ?? RETRIEVAL_DEFAULTS.seedLimit), 1, 100),
    };
}

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
}

function round6(value: number): number {
    return Math.round(value * 1e6) / 1e6;
}

// --- Dataset (§7.5: immer das erlaubte; Klammer VOR der Expansion) -------

/**
 * Traversal-Raum des Retrievals: die Wissens-Graphen (workspace + public
 * + import/* + meta + geteilte Räume — dieselbe Scope-Linie wie das
 * M7-Reasoning). presentation (Layout), vocab/shapes (Schema) und acl
 * sind KEIN Traversal-Raum; inferred/<scope> kommt ausschließlich über
 * `includeInferred: true` dazu. Explizit angeforderte Graphen werden
 * gegen diese Menge gefiltert — still, ohne Existenzbestätigung (§17.3).
 *
 * Mit einem Grant (M13) spannt der Raum ALLE Nutzer und Räume auf, bevor
 * die Rechte ihn wieder zusammenziehen: nur so erreicht ein Retrieval
 * einen geteilten Raum oder einen fremden öffentlichen Graphen. Ohne
 * Grant bleibt es beim eigenen Nutzer — das ist der Einzelnutzer-Pfad
 * (Runtime `local`, Hintergrundaufgaben), der nie fremde Daten sieht.
 */
export async function retrievalDataset(
    handle: GraphHandle,
    options: { graphs?: string[]; includeInferred: boolean } & RetrievalAuthz,
): Promise<string[]> {
    const existing = (await handle.store.graphs()).map(g => g.value);
    const knowledge = options.allowedGraphs
        ? knowledgeGraphs(handle.iri.instanceBase, existing)
        : workspaceScopeGraphs(handle.iri, existing);
    const inferred = handle.iri.inferredGraph('workspace');
    const withInferred = options.includeInferred && existing.includes(inferred)
        ? [...knowledge, inferred]
        : knowledge;
    // Grant-Klammer (SPEC §7.6): Das Recht des Aufrufers kann nur
    // wegnehmen. Sie greift VOR der Expansion — ein gesperrter Graph ist
    // damit auch über Hops unerreichbar, nicht bloß nachgefiltert.
    const granted = options.allowedGraphs
        ? withInferred.filter(g => options.allowedGraphs!.includes(g))
        : withInferred;
    if (!options.graphs || options.graphs.length === 0) return [...granted].sort();
    const requested = new Set(options.graphs);
    return granted.filter(g => requested.has(g)).sort();
}

// --- SPARQL-Hilfen -------------------------------------------------------

function iriRef(iri: string): string {
    return `<${iri.replace(/[<>"{}|^`\\\s]/g, encodeURIComponent)}>`;
}

function valuesClause(variable: string, iris: readonly string[]): string {
    return `VALUES ?${variable} { ${iris.map(iriRef).join(' ')} }`;
}

async function selectRows(
    handle: GraphHandle,
    sparql: string,
    graphs: readonly string[],
): Promise<Array<Record<string, Term>>> {
    const dataset = graphs.map(namedNode);
    const result = await handle.store.query(sparql, { defaultGraphs: dataset, namedGraphs: dataset });
    if (result.type !== 'bindings') return [];
    const rows: Array<Record<string, Term>> = [];
    for await (const row of result.bindings) rows.push(row);
    return rows;
}

// --- Phase 1: Seeding ----------------------------------------------------

export interface SeedInfo {
    score: number;
    sources: string[];
}

export interface SeedingResult {
    seeds: Map<string, SeedInfo>;
    strategy: string;
    notes: string[];
}

function mergeSeed(map: Map<string, SeedInfo>, iri: string, score: number, source: string): void {
    const existing = map.get(iri);
    if (!existing) {
        map.set(iri, { score: round6(score), sources: [source] });
        return;
    }
    existing.score = round6(Math.max(existing.score, score));
    if (!existing.sources.includes(source)) existing.sources.push(source);
}

/**
 * Seeding (§7.5 Phase 1): drei kombinierbare Quellen, jeder Seed trägt
 * einen Score in (0, 1]. IRIs, die im erlaubten Dataset nicht vorkommen,
 * werden still verworfen (keine Existenzbestätigung).
 */
export async function seedPhase(
    handle: GraphHandle,
    dataset: readonly string[],
    seeds: RetrievalSeeds | undefined,
    seedLimit: number,
    deps: RetrievalDeps,
): Promise<SeedingResult> {
    const map = new Map<string, SeedInfo>();
    const strategyParts: string[] = [];
    const notes: string[] = [];

    if (seeds?.iri && seeds.iri.length > 0 && dataset.length > 0) {
        const requested = [...new Set(seeds.iri)].sort();
        const rows = await selectRows(
            handle,
            `SELECT DISTINCT ?n WHERE {
                ${valuesClause('n', requested)}
                { GRAPH ?g { ?n ?p ?o } } UNION { GRAPH ?g2 { ?x ?p2 ?n } }
            }`,
            dataset,
        );
        let used = 0;
        for (const row of rows) {
            const term = row.n;
            if (term?.termType === 'NamedNode') {
                mergeSeed(map, term.value, 1, 'iri');
                used += 1;
            }
        }
        strategyParts.push(`iri(${used}/${requested.length})`);
    }

    const queryText = seeds?.text?.trim();
    if (queryText) {
        const fulltext = deps.fulltext;
        if (fulltext) {
            const hits = fulltext.search(queryText, { limit: seedLimit, graphs: dataset });
            const maxScore = hits[0]?.score ?? 0;
            for (const hit of hits) {
                mergeSeed(map, hit.iri, maxScore > 0 ? hit.score / maxScore : 0, 'text');
            }
            strategyParts.push(`text:volltext(${hits.length})`);
        } else {
            notes.push('Volltext-Index nicht verfügbar — Text-Seeding übersprungen.');
        }
        if (deps.vector && deps.embedQuery) {
            const vector = await deps.embedQuery(queryText);
            const hits = deps.vector.search(vector, { limit: seedLimit, graphs: dataset });
            for (const hit of hits) {
                mergeSeed(map, hit.iri, Math.max(0, hit.similarity), 'vector');
            }
            strategyParts.push(`text:vektor(${hits.length})`);
        }
    }

    if (seeds?.vector && seeds.vector.length > 0) {
        if (deps.vector) {
            const hits = deps.vector.search(seeds.vector, { limit: seedLimit, graphs: dataset });
            for (const hit of hits) {
                mergeSeed(map, hit.iri, Math.max(0, hit.similarity), 'vector');
            }
            strategyParts.push(`vektor(${hits.length})`);
        } else {
            notes.push('Kein Vektorindex (Embeddings nicht konfiguriert) — Vektor-Seeding übersprungen.');
        }
    }

    // Score 0 trägt nichts bei — raus, bevor die Expansion damit läuft.
    for (const [iri, info] of map) {
        if (info.score <= 0) map.delete(iri);
    }
    return {
        seeds: map,
        strategy: strategyParts.length > 0 ? strategyParts.join(' + ') : 'leer',
        notes,
    };
}

// --- Phase 2: Expansion --------------------------------------------------

interface NodeState {
    hop: number;
    /** Bester Pfad-Grundscore: seed × decay^hop × Kantengewichte. */
    base: number;
    seedScore: number;
    decayFactor: number;
    edgeWeight: number;
    seedSources?: string[];
    via?: { from: string; predicate: string };
}

export interface ExpansionResult {
    nodes: Map<string, NodeState>;
    hopsUsed: number;
    prunedAt: string[];
    truncated: boolean;
    notes: string[];
}

interface TraversalEdge {
    s: string;
    p: string;
    o: string;
    graph: string;
    weight: number;
}

const RDF_TYPE = RDF.type;

/** Kantengewicht aus RDF-1.2-Annotation (ow:weight am benannten Reifier). */
function parseWeight(term: Term | undefined): number {
    if (!term || term.termType !== 'Literal') return 1;
    const value = Number.parseFloat(term.value);
    if (!Number.isFinite(value) || value <= 0) return 1;
    return Math.min(value, 10);
}

async function fetchFrontierEdges(
    handle: GraphHandle,
    dataset: readonly string[],
    frontier: readonly string[],
    direction: RetrievalRequest['direction'],
): Promise<TraversalEdge[]> {
    const queries: string[] = [];
    if (direction === 'out' || direction === 'both') {
        queries.push(`SELECT ?s ?p ?o ?g ?w WHERE {
            ${valuesClause('s', frontier)}
            GRAPH ?g { ?s ?p ?o }
            FILTER(isIRI(?o))
            OPTIONAL { GRAPH ?gw { ?r <${RDF.reifies}> <<( ?s ?p ?o )>> . ?r <${OW.weight}> ?w } }
        }`);
    }
    if (direction === 'in' || direction === 'both') {
        queries.push(`SELECT ?s ?p ?o ?g ?w WHERE {
            ${valuesClause('o', frontier)}
            GRAPH ?g { ?s ?p ?o }
            FILTER(isIRI(?s))
            OPTIONAL { GRAPH ?gw { ?r <${RDF.reifies}> <<( ?s ?p ?o )>> . ?r <${OW.weight}> ?w } }
        }`);
    }
    const byKey = new Map<string, TraversalEdge>();
    for (const sparql of queries) {
        for (const row of await selectRows(handle, sparql, dataset)) {
            const s = row.s;
            const p = row.p;
            const o = row.o;
            const g = row.g;
            if (s?.termType !== 'NamedNode' || p?.termType !== 'NamedNode' || o?.termType !== 'NamedNode') continue;
            if (g?.termType !== 'NamedNode') continue;
            const key = `${s.value}\n${p.value}\n${o.value}\n${g.value}`;
            const weight = parseWeight(row.w);
            const existing = byKey.get(key);
            if (!existing) {
                byKey.set(key, { s: s.value, p: p.value, o: o.value, graph: g.value, weight });
            } else if (weight > existing.weight) {
                existing.weight = weight; // mehrere Reifier: das stärkste Gewicht zählt
            }
        }
    }
    return [...byKey.values()].sort((a, b) =>
        a.s.localeCompare(b.s) || a.p.localeCompare(b.p) || a.o.localeCompare(b.o) || a.graph.localeCompare(b.graph));
}

/**
 * Kandidaten, über die im erlaubten Dataset überhaupt etwas ausgesagt
 * wird (Subjekt-Position). Ein Knoten, der nur als Objekt einer Kante
 * vorkommt, trägt nichts zum Kontext bei — und darf nicht aufgenommen
 * werden: Er läge sonst als bloße IRI im Ergebnis und würde die Existenz
 * eines Knotens verraten, dessen Aussagen alle in einem Graphen liegen,
 * den der Aufrufer nicht lesen darf (SPEC §7.6-Negativtest).
 */
async function fetchReadableSubjects(
    handle: GraphHandle,
    dataset: readonly string[],
    iris: readonly string[],
): Promise<Set<string>> {
    const readable = new Set<string>();
    if (iris.length === 0 || dataset.length === 0) return readable;
    const rows = await selectRows(
        handle,
        `SELECT DISTINCT ?n WHERE { ${valuesClause('n', iris)} GRAPH ?g { ?n ?p ?o } }`,
        dataset,
    );
    for (const row of rows) {
        if (row.n?.termType === 'NamedNode') readable.add(row.n.value);
    }
    return readable;
}

async function fetchTypes(
    handle: GraphHandle,
    dataset: readonly string[],
    iris: readonly string[],
): Promise<Map<string, string[]>> {
    const types = new Map<string, string[]>();
    if (iris.length === 0) return types;
    const rows = await selectRows(
        handle,
        `SELECT ?n ?t WHERE { ${valuesClause('n', iris)} GRAPH ?g { ?n <${RDF_TYPE}> ?t } FILTER(isIRI(?t)) }`,
        dataset,
    );
    for (const row of rows) {
        if (row.n?.termType !== 'NamedNode' || row.t?.termType !== 'NamedNode') continue;
        const list = types.get(row.n.value) ?? [];
        if (!list.includes(row.t.value)) list.push(row.t.value);
        types.set(row.n.value, list);
    }
    for (const list of types.values()) list.sort();
    return types;
}

function makeEdgePredicateFilter(edgeTypes: RetrievalRequest['edgeTypes']): (predicate: string) => boolean {
    const include = edgeTypes?.include && edgeTypes.include.length > 0 ? new Set(edgeTypes.include) : null;
    const exclude = new Set(edgeTypes?.exclude ?? []);
    return (predicate: string) => {
        if (include) return include.has(predicate);
        if (exclude.has(predicate)) return false;
        // rdf:type ist Typinformation, keine Wissens-Kante: Klassen-Knoten
        // würden sonst jedes Retrieval zu „alles ist 2 Hops entfernt"
        // machen. Über edgeTypes.include ist der Typ-Hop explizit möglich.
        return predicate !== RDF_TYPE;
    };
}

function makeNodeTypeFilter(nodeTypes: RetrievalRequest['nodeTypes']): (types: readonly string[]) => boolean {
    const include = nodeTypes?.include && nodeTypes.include.length > 0 ? new Set(nodeTypes.include) : null;
    const exclude = new Set(nodeTypes?.exclude ?? []);
    return (types: readonly string[]) => {
        if (types.some(t => exclude.has(t))) return false;
        if (include) return types.some(t => include.has(t));
        return true;
    };
}

/**
 * Expansion (§7.5 Phase 2): BFS von den Seeds, hop-weise, deterministisch.
 * Grad-Kappung: überschreitet die Zahl der traversierbaren Kanten eines
 * Frontier-Knotens `maxDegree`, wird durch ihn NICHT expandiert (der
 * Knoten selbst bleibt Ergebnis; `explain.prunedAt` weist ihn aus).
 */
export async function expandPhase(
    handle: GraphHandle,
    dataset: readonly string[],
    seeds: Map<string, SeedInfo>,
    request: RetrievalRequest,
    deps: RetrievalDeps = {},
): Promise<ExpansionResult> {
    const now = deps.now ?? Date.now;
    const deadline = now() + HARD_MAX_DURATION_MS;
    const allowPredicate = makeEdgePredicateFilter(request.edgeTypes);
    const allowNodeTypes = makeNodeTypeFilter(request.nodeTypes);
    const maxDegree = request.maxDegree ?? RETRIEVAL_DEFAULTS.maxDegree;

    const nodes = new Map<string, NodeState>();
    const sortedSeeds = [...seeds.entries()].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
    for (const [iri, info] of sortedSeeds) {
        if (nodes.size >= request.maxNodes) break;
        nodes.set(iri, {
            hop: 0,
            base: info.score,
            seedScore: info.score,
            decayFactor: 1,
            edgeWeight: 1,
            seedSources: [...info.sources].sort(),
        });
    }
    const result: ExpansionResult = {
        nodes,
        hopsUsed: 0,
        prunedAt: [],
        truncated: nodes.size < seeds.size,
        notes: nodes.size < seeds.size ? ['maxNodes bereits im Seeding erreicht.'] : [],
    };
    if (dataset.length === 0 || nodes.size === 0) return result;

    let frontier = [...nodes.keys()];
    for (let hop = 1; hop <= request.maxHops; hop++) {
        if (frontier.length === 0) break;
        if (now() > deadline) {
            result.truncated = true;
            result.notes.push('Laufzeit-Obergrenze erreicht — Expansion abgebrochen.');
            break;
        }
        const edges = await fetchFrontierEdges(handle, dataset, frontier, request.direction);

        // Traversierbare Kanten je Frontier-Knoten (Grad = deren Anzahl),
        // strikt in Traversal-Richtung: 'out' folgt s→o, 'in' folgt o→s.
        const perNode = new Map<string, TraversalEdge[]>();
        for (const iri of frontier) perNode.set(iri, []);
        for (const edge of edges) {
            if (!allowPredicate(edge.p)) continue;
            if ((request.direction === 'out' || request.direction === 'both') && perNode.has(edge.s)) {
                perNode.get(edge.s)!.push(edge);
            }
            if ((request.direction === 'in' || request.direction === 'both') && edge.o !== edge.s && perNode.has(edge.o)) {
                perNode.get(edge.o)!.push(edge);
            }
        }

        // Kandidaten (nur über nicht gekappte Knoten) für die Typ-Abfrage.
        const hubPruned = new Set<string>();
        const candidates = new Set<string>();
        for (const iri of frontier) {
            const list = perNode.get(iri) ?? [];
            if (list.length > maxDegree) {
                hubPruned.add(iri);
                continue;
            }
            for (const edge of list) {
                const other = edge.s === iri ? edge.o : edge.s;
                if (!nodes.has(other)) candidates.add(other);
            }
        }
        result.prunedAt.push(...[...hubPruned].sort());
        const candidateList = [...candidates].sort();
        const candidateTypes = await fetchTypes(handle, dataset, candidateList);
        const readableCandidates = await fetchReadableSubjects(handle, dataset, candidateList);

        // Deterministische Aufnahme: Frontier nach (base desc, IRI asc),
        // Kanten je Knoten nach (Prädikat, Nachbar-IRI, Graph).
        const orderedFrontier = frontier
            .filter(iri => !hubPruned.has(iri))
            .sort((a, b) => (nodes.get(b)!.base - nodes.get(a)!.base) || a.localeCompare(b));
        const admitted: string[] = [];
        for (const iri of orderedFrontier) {
            const state = nodes.get(iri)!;
            const list = (perNode.get(iri) ?? []).slice().sort((a, b) => {
                const otherA = a.s === iri ? a.o : a.s;
                const otherB = b.s === iri ? b.o : b.s;
                return a.p.localeCompare(b.p) || otherA.localeCompare(otherB) || a.graph.localeCompare(b.graph);
            });
            for (const edge of list) {
                const other = edge.s === iri ? edge.o : edge.s;
                if (other === iri) continue;
                const decayFactor = state.decayFactor * request.decay;
                const edgeWeight = state.edgeWeight * edge.weight;
                const base = round6(state.seedScore * decayFactor * edgeWeight);
                const known = nodes.get(other);
                if (known) {
                    if (base > known.base) {
                        known.base = base;
                        known.seedScore = state.seedScore;
                        known.decayFactor = decayFactor;
                        known.edgeWeight = edgeWeight;
                        known.via = { from: iri, predicate: edge.p };
                    }
                    continue;
                }
                // Nur Knoten, über die im erlaubten Dataset etwas steht.
                if (!readableCandidates.has(other)) continue;
                if (nodes.size >= request.maxNodes) {
                    result.truncated = true;
                    continue;
                }
                if (!allowNodeTypes(candidateTypes.get(other) ?? [])) continue;
                nodes.set(other, {
                    hop,
                    base,
                    seedScore: state.seedScore,
                    decayFactor,
                    edgeWeight,
                    via: { from: iri, predicate: edge.p },
                });
                admitted.push(other);
                result.hopsUsed = hop;
            }
        }
        frontier = admitted;
    }
    result.prunedAt = [...new Set(result.prunedAt)].sort();
    return result;
}

// --- Phase 3: Scoring ----------------------------------------------------

export interface ScoredNode extends NodeState {
    iri: string;
    score: number;
    centrality: number;
    recency: number;
}

/**
 * Scoring (§7.5 Phase 3), deterministisch und erklärbar:
 *
 *   score = base × zentralität × aktualität
 *   base  = seedScore × decay^hop × Kantengewichts-Produkt (bester Pfad)
 *   zentralität = 1 + 0.1 × log(1+grad) / log(1+maxGrad)   (Grad im Subgraphen)
 *   aktualität  = 0.9 + 0.1 × normierter Zeitstempel        (ohne Datum: 0.95)
 *
 * Die Normierung der Aktualität läuft gegen min/max der Zeitstempel IM
 * Ergebnis (kein Wall-Clock-Bezug — Reproduzierbarkeit).
 */
export function scorePhase(
    nodes: Map<string, NodeState>,
    degreeByNode: Map<string, number>,
    timestampByNode: Map<string, number>,
): ScoredNode[] {
    const maxDegree = Math.max(1, ...degreeByNode.values());
    const datedValues = [...nodes.keys()]
        .map(iri => timestampByNode.get(iri))
        .filter((v): v is number => v !== undefined);
    const minTime = datedValues.length > 0 ? Math.min(...datedValues) : 0;
    const maxTime = datedValues.length > 0 ? Math.max(...datedValues) : 0;

    const scored: ScoredNode[] = [];
    for (const [iri, state] of nodes) {
        const degree = degreeByNode.get(iri) ?? 0;
        const centrality = round6(1 + 0.1 * (Math.log(1 + degree) / Math.log(1 + maxDegree)));
        const timestamp = timestampByNode.get(iri);
        const recency = timestamp === undefined
            ? 0.95
            : maxTime === minTime
                ? 1
                : round6(0.9 + 0.1 * ((timestamp - minTime) / (maxTime - minTime)));
        scored.push({
            ...state,
            iri,
            centrality,
            recency,
            score: round6(state.base * centrality * recency),
        });
    }
    scored.sort((a, b) => b.score - a.score || a.hop - b.hop || a.iri.localeCompare(b.iri));
    return scored;
}

// --- Phase 4: Assembly ---------------------------------------------------

const LABEL_PREDICATES: readonly string[] = [SCHEMA.name, SKOS.prefLabel, `${PREFIXES.rdfs}label`, `${PREFIXES.dcterms}title`];
const TEXT_PREDICATES: readonly string[] = [SCHEMA.description, SCHEMA.text];
const TIME_PREDICATES: readonly string[] = [DCTERMS.modified, DCTERMS.created, PROV.endedAtTime, PROV.generatedAtTime];

interface NodeDetails {
    labels: Map<string, string>;
    texts: Map<string, string>;
    types: Map<string, string[]>;
    timestamps: Map<string, number>;
    graphsByNode: Map<string, string[]>;
}

async function fetchNodeDetails(
    handle: GraphHandle,
    dataset: readonly string[],
    iris: readonly string[],
): Promise<NodeDetails> {
    const details: NodeDetails = {
        labels: new Map(),
        texts: new Map(),
        types: await fetchTypes(handle, dataset, iris),
        timestamps: new Map(),
        graphsByNode: new Map(),
    };
    if (iris.length === 0) return details;
    const rows = await selectRows(
        handle,
        `SELECT ?n ?p ?v ?g WHERE { ${valuesClause('n', iris)} GRAPH ?g { ?n ?p ?v } }`,
        dataset,
    );
    // Deterministische Auswahl: Zeilen sortiert verarbeiten, erster Wert gewinnt.
    rows.sort((a, b) =>
        (a.n?.value ?? '').localeCompare(b.n?.value ?? '') ||
        (a.p?.value ?? '').localeCompare(b.p?.value ?? '') ||
        (a.g?.value ?? '').localeCompare(b.g?.value ?? '') ||
        (a.v?.value ?? '').localeCompare(b.v?.value ?? ''));
    for (const row of rows) {
        if (row.n?.termType !== 'NamedNode' || row.p?.termType !== 'NamedNode') continue;
        const iri = row.n.value;
        const predicate = row.p.value;
        if (row.g?.termType === 'NamedNode') {
            const list = details.graphsByNode.get(iri) ?? [];
            if (!list.includes(row.g.value)) list.push(row.g.value);
            details.graphsByNode.set(iri, list);
        }
        if (row.v?.termType !== 'Literal') continue;
        const value = row.v.value;
        if (LABEL_PREDICATES.includes(predicate) && !details.labels.has(iri)) {
            details.labels.set(iri, value);
        }
        if (TEXT_PREDICATES.includes(predicate)) {
            const existing = details.texts.get(iri);
            // schema:description gewinnt gegen schema:text (kompakter).
            if (!existing || (predicate === SCHEMA.description && existing.length > value.length)) {
                details.texts.set(iri, value);
            }
        }
        if (TIME_PREDICATES.includes(predicate)) {
            const parsed = Date.parse(value);
            if (Number.isFinite(parsed)) {
                const existing = details.timestamps.get(iri);
                if (existing === undefined || parsed > existing) details.timestamps.set(iri, parsed);
            }
        }
    }
    return details;
}

/** Kanten-Hülle: alle Kanten ZWISCHEN den aufgenommenen Knoten. */
async function fetchClosureEdges(
    handle: GraphHandle,
    dataset: readonly string[],
    iris: readonly string[],
    edgeTypes: RetrievalRequest['edgeTypes'],
): Promise<{ edges: RetrievalEdge[]; degreeByNode: Map<string, number>; truncated: boolean }> {
    const degreeByNode = new Map<string, number>();
    if (iris.length === 0 || dataset.length === 0) {
        return { edges: [], degreeByNode, truncated: false };
    }
    const allowPredicate = makeEdgePredicateFilter(edgeTypes);
    const rows = await selectRows(
        handle,
        `SELECT ?s ?p ?o ?g WHERE {
            ${valuesClause('s', iris)}
            ${valuesClause('o', iris)}
            GRAPH ?g { ?s ?p ?o }
        }`,
        dataset,
    );
    const byKey = new Map<string, RetrievalEdge>();
    for (const row of rows) {
        if (row.s?.termType !== 'NamedNode' || row.p?.termType !== 'NamedNode' ||
            row.o?.termType !== 'NamedNode' || row.g?.termType !== 'NamedNode') continue;
        if (!allowPredicate(row.p.value)) continue;
        const key = `${row.s.value}\n${row.p.value}\n${row.o.value}\n${row.g.value}`;
        if (byKey.has(key)) continue;
        byKey.set(key, {
            s: row.s.value,
            p: row.p.value,
            o: row.o.value,
            graph: row.g.value,
            inferred: row.g.value.includes('/inferred/'),
        });
    }
    let edges = [...byKey.values()].sort((a, b) =>
        a.s.localeCompare(b.s) || a.p.localeCompare(b.p) || a.o.localeCompare(b.o) || a.graph.localeCompare(b.graph));
    const truncated = edges.length > HARD_MAX_EDGES;
    if (truncated) edges = edges.slice(0, HARD_MAX_EDGES);
    for (const edge of edges) {
        degreeByNode.set(edge.s, (degreeByNode.get(edge.s) ?? 0) + 1);
        if (edge.o !== edge.s) degreeByNode.set(edge.o, (degreeByNode.get(edge.o) ?? 0) + 1);
    }
    return { edges, degreeByNode, truncated };
}

/** Provenienz: Quell-Graph mit deterministischer Priorität + Connector. */
function provenanceFor(
    handle: GraphHandle,
    iri: string,
    graphsOfNode: readonly string[] | undefined,
    fallbackGraph: string | undefined,
): RetrievalProvenance {
    const base = handle.iri.instanceBase;
    const candidates = graphsOfNode && graphsOfNode.length > 0
        ? [...graphsOfNode]
        : fallbackGraph
            ? [fallbackGraph]
            : [];
    const rank = (graph: string): number => {
        if (graph === handle.iri.graph('workspace')) return 0;
        if (graph === handle.iri.graph('public')) return 1;
        if (graph.startsWith(handle.iri.importGraph(''))) return 2;
        if (graph === handle.iri.sharedGraph('meta')) return 3;
        if (graph.includes('/inferred/')) return 4;
        return 5;
    };
    candidates.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const sourceGraph = candidates[0] ?? `${base}graph/unbekannt`;
    const importPrefix = handle.iri.importGraph('');
    return {
        iri,
        sourceGraph,
        ...(sourceGraph.startsWith(importPrefix)
            ? { connector: decodeURIComponent(sourceGraph.slice(importPrefix.length)) }
            : {}),
    };
}

/** Token-Heuristik des Kontext-Budgets: ~4 Zeichen pro Token, dokumentiert. */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

function localName(iriValue: string): string {
    const cut = Math.max(iriValue.lastIndexOf('#'), iriValue.lastIndexOf('/'));
    const local = cut === -1 ? iriValue : iriValue.slice(cut + 1);
    return local === '' ? iriValue : decodeURIComponent(local);
}

interface ContextResult {
    context: string;
    truncated: boolean;
}

/**
 * Linearisierter Kontext (§7.5 Phase 4): [n]-nummerierte Blöcke in
 * Score-Reihenfolge, zitierfähig, gekappt am Token-Budget — ganze Blöcke,
 * entlang der Score-Reihenfolge.
 */
function buildContext(
    orderedNodes: readonly RetrievalNode[],
    edges: readonly RetrievalEdge[],
    provenance: readonly RetrievalProvenance[],
    details: NodeDetails,
    tokenBudget: number,
): ContextResult {
    const numberByIri = new Map(orderedNodes.map((node, index) => [node.iri, index + 1]));
    const provenanceByIri = new Map(provenance.map(p => [p.iri, p]));
    const edgesBySubject = new Map<string, RetrievalEdge[]>();
    for (const edge of edges) {
        const list = edgesBySubject.get(edge.s) ?? [];
        list.push(edge);
        edgesBySubject.set(edge.s, list);
    }

    const blocks: string[] = [];
    let tokens = 0;
    let truncated = false;
    for (const node of orderedNodes) {
        const n = numberByIri.get(node.iri)!;
        const label = node.label ?? localName(node.iri);
        const types = node.types.map(localName).join(', ');
        const lines = [`[${n}] ${label}${types ? ` (${types})` : ''} — ${node.iri}`];
        const prov = provenanceByIri.get(node.iri);
        if (prov) {
            lines.push(`    Quelle: ${prov.connector ? `Connector „${prov.connector}"` : prov.sourceGraph}${prov.sourceGraph.includes('/inferred/') ? ' [inferiert]' : ''}`);
        }
        const text = details.texts.get(node.iri);
        if (text) {
            const compact = text.replace(/\s+/g, ' ').trim();
            lines.push(`    ${compact.length > 400 ? `${compact.slice(0, 400)}…` : compact}`);
        }
        const related = (edgesBySubject.get(node.iri) ?? [])
            .filter(edge => numberByIri.has(edge.o) && edge.o !== node.iri)
            .slice(0, 6)
            .map(edge => `${localName(edge.p)} → [${numberByIri.get(edge.o)}]${edge.inferred ? ' [inferiert]' : ''}`);
        if (related.length > 0) {
            lines.push(`    Beziehungen: ${related.join('; ')}`);
        }
        const block = lines.join('\n');
        const blockTokens = estimateTokens(block);
        if (tokens + blockTokens > tokenBudget) {
            truncated = true;
            break;
        }
        tokens += blockTokens;
        blocks.push(block);
    }
    return { context: blocks.join('\n\n'), truncated };
}

// --- Orchestrierung ------------------------------------------------------

export async function retrieve(
    handle: GraphHandle,
    input: RetrievalRequestInput,
    deps: RetrievalDeps = {},
    authz: RetrievalAuthz = {},
): Promise<RetrievalResult> {
    const request = withRetrievalDefaults(input);
    const dataset = await retrievalDataset(handle, {
        graphs: request.graphs,
        includeInferred: request.includeInferred,
        ...(authz.allowedGraphs ? { allowedGraphs: authz.allowedGraphs } : {}),
    });

    // Phase 1: Seeding.
    const seeding = await seedPhase(handle, dataset, request.seeds, request.seedLimit ?? 10, deps);

    // Phase 2: Expansion.
    const expansion = await expandPhase(handle, dataset, seeding.seeds, request, deps);
    const includedIris = [...expansion.nodes.keys()].sort();

    // Kanten-Hülle + Details (eine VALUES-Query je Aspekt).
    const closure = await fetchClosureEdges(handle, dataset, includedIris, request.edgeTypes);
    const details = await fetchNodeDetails(handle, dataset, includedIris);

    // Phase 3: Scoring.
    const scored = scorePhase(expansion.nodes, closure.degreeByNode, details.timestamps);

    const nodes: RetrievalNode[] = scored.map(node => ({
        iri: node.iri,
        score: node.score,
        hop: node.hop,
        types: details.types.get(node.iri) ?? [],
        ...(details.labels.has(node.iri) ? { label: details.labels.get(node.iri) } : {}),
        ...(node.seedSources ? { seed: node.seedSources } : {}),
        ...(node.via ? { via: node.via } : {}),
        scoreParts: {
            seed: round6(node.seedScore),
            decay: round6(node.decayFactor),
            edgeWeight: round6(node.edgeWeight),
            centrality: node.centrality,
            recency: node.recency,
        },
    }));

    const provenance = nodes.map(node =>
        provenanceFor(handle, node.iri, details.graphsByNode.get(node.iri), undefined));

    // Phase 4: Assembly (Kontext nur, wenn angefordert).
    let context: string | undefined;
    let contextTruncated = false;
    if (request.format === 'context' || request.format === 'both') {
        const built = buildContext(nodes, closure.edges, provenance, details,
            request.tokenBudget ?? RETRIEVAL_DEFAULTS.tokenBudget);
        context = built.context;
        contextTruncated = built.truncated;
    }

    const notes = [...seeding.notes, ...expansion.notes];
    if (closure.truncated) notes.push(`Kanten-Obergrenze (${HARD_MAX_EDGES}) erreicht.`);
    if (contextTruncated) notes.push('Token-Budget erreicht — Kontext entlang der Score-Reihenfolge gekappt.');

    return {
        nodes,
        edges: request.format === 'context' ? [] : closure.edges,
        ...(context !== undefined ? { context } : {}),
        provenance,
        truncated: expansion.truncated || closure.truncated || contextTruncated,
        explain: {
            seedStrategy: seeding.strategy,
            hopsUsed: expansion.hopsUsed,
            ...(expansion.prunedAt.length > 0 ? { prunedAt: expansion.prunedAt } : {}),
            ...(notes.length > 0 ? { notes } : {}),
        },
    };
}

/** Baut den Volltext-Index über das Dataset (für Aufrufer ohne Cache). */
export async function buildFulltextIndexForGraphs(
    handle: GraphHandle,
    graphs: readonly string[],
): Promise<FulltextIndex> {
    const quads = [];
    for (const graph of graphs) {
        for await (const q of handle.store.dump(namedNode(graph))) {
            quads.push(q);
        }
    }
    return FulltextIndex.fromQuads(quads);
}
