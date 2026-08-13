/**
 * Reasoning- und Validierungs-Pipeline (SPEC §7.2/§7.3, M7).
 *
 * Scope-Partitionierung (Inferenz-Leak, §7.3 — verbindlich): Der Reasoner
 * läuft EINMAL PRO SICHTBARKEITS-SCOPE über genau das Dataset, das dieser
 * Scope sehen darf, und schreibt in den scope-eigenen Inferenz-Graphen
 * `graph/<u>/inferred/<scope>` — vollständiger Replace, nie gemerged
 * (Invariante 3). Ein Inferenz-Graph speist niemals ein Dataset, das
 * weniger sieht als sein Quell-Dataset:
 *
 *   Scope `workspace` (Eigentümer-Sicht): workspace + public + import/* + meta
 *   Scope `public`    (anonyme Sicht):    ausschließlich public
 *
 * Schema beider Scopes ist graph/vocab (öffentlich lesbar). presentation
 * trägt kein Wissen, shapes sind Constraints, acl ist tabu — keiner davon
 * ist Reasoning-Input. Alles läuft über dump/load (kein SPARQL), damit
 * die Pipeline mit Oxigraph UND dem Memory-Double funktioniert.
 *
 * `graph/<u>/inferred/*` wird nie persistiert (SPEC §8.1) und ist aus dem
 * Default-Dataset jeder Query ausgeschlossen (SPEC §3.3, resolveDataset).
 */

import type { Quad } from '@rdfjs/types';
import type { GraphStore } from '../store/types';
import type { IriFactory } from '../iri';
import { factory, namedNode, typedLiteral } from '../rdf';
import { PROV, RDF } from '../vocab';
import { causalGraphsOf } from '../causal/model';
import { deriveOwlRlInferences } from './owl-rl';
import { reportQuads, validateQuads, type ShaclReport } from './shacl';

export interface GraphHandle {
    store: GraphStore;
    iri: IriFactory;
}

export type ReasoningScopeId = 'workspace' | 'public';

export interface ReasoningScope {
    scope: ReasoningScopeId;
    /** Daten-Graphen, die dieser Scope sehen darf (existierende IRIs). */
    dataGraphs: string[];
    /** Ziel: der scope-eigene Inferenz-Graph. */
    inferredGraph: string;
}

async function collect(store: GraphStore, graphIri: string): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const q of store.dump(namedNode(graphIri))) {
        quads.push(q);
    }
    return quads;
}

/** Wissens-Graphen der Eigentümer-Sicht (ohne presentation/shapes/acl/inferred). */
export function workspaceScopeGraphs(iri: IriFactory, existing: string[]): string[] {
    const wanted = new Set([iri.graph('workspace'), iri.graph('public'), iri.sharedGraph('meta')]);
    // Prefix aller Import-Graphen — aus der Fabrik abgeleitet, damit die
    // Kodierung der Nutzer-ID exakt der IRI-Strategie folgt.
    const importPrefix = iri.importGraph('');
    return existing
        .filter(g => wanted.has(g) || g.startsWith(importPrefix))
        .sort();
}

/** Die Sichtbarkeits-Scopes dieser Installation (Single-User: zwei). */
export function reasoningScopes(iri: IriFactory, existing: string[]): ReasoningScope[] {
    const publicGraph = iri.graph('public');
    return [
        {
            scope: 'workspace',
            dataGraphs: workspaceScopeGraphs(iri, existing),
            inferredGraph: iri.inferredGraph('workspace'),
        },
        {
            scope: 'public',
            dataGraphs: existing.includes(publicGraph) ? [publicGraph] : [],
            inferredGraph: iri.inferredGraph('public'),
        },
    ];
}

export interface ReasoningRunSummary {
    scope: ReasoningScopeId;
    /** IRI des Inferenz-Graphen. */
    graph: string;
    /** Anzahl abgeleiteter Tripel (ohne PROV-Buchführung). */
    inferred: number;
    /** Größe des Eingabe-Datasets. */
    dataQuads: number;
    generatedAt: string;
    durationMs: number;
}

/**
 * Materialisiert die OWL-RL-Folgerungen aller Scopes (§7.3): pro Scope
 * vollständiger Replace des Inferenz-Graphen in EINER Transaktion, mit
 * `prov:wasGeneratedBy` auf den Reasoning-Lauf. Läuft nach jedem Import,
 * beim Bootstrap und auf Anforderung (API/Explorer).
 */
export async function runReasoning(handle: GraphHandle, options: { now?: () => Date } = {}): Promise<ReasoningRunSummary[]> {
    const now = options.now ?? (() => new Date());
    const existing = (await handle.store.graphs()).map(g => g.value);
    const schemaQuads = await collect(handle.store, handle.iri.sharedGraph('vocab'));
    const summaries: ReasoningRunSummary[] = [];
    const perScope: Array<{ scope: ReasoningScope; quads: Quad[] }> = [];

    for (const scope of reasoningScopes(handle.iri, existing)) {
        const started = Date.now();
        const dataQuads: Quad[] = [];
        for (const graphIri of scope.dataGraphs) {
            dataQuads.push(...await collect(handle.store, graphIri));
        }
        const inferred = deriveOwlRlInferences(schemaQuads, dataQuads);
        const generatedAt = now().toISOString();
        const graph = namedNode(scope.inferredGraph);
        const activity = namedNode(handle.iri.entity('activity', `reasoning-${scope.scope}`));
        const quads: Quad[] = inferred.map(t => factory.quad(t.subject, t.predicate, t.object, graph));
        // PROV am Graphen selbst (Muster wie Import-Graphen, SPEC §6.2):
        // der Graph wird komplett ersetzt, die Buchführung gehört zum Lauf.
        quads.push(
            factory.quad(graph, namedNode(PROV.wasGeneratedBy), activity, graph),
            factory.quad(graph, namedNode(PROV.generatedAtTime), typedLiteral.dateTime(generatedAt), graph),
            factory.quad(activity, namedNode(RDF.type), namedNode(PROV.Activity), graph),
        );
        perScope.push({ scope, quads });
        summaries.push({
            scope: scope.scope,
            graph: scope.inferredGraph,
            inferred: inferred.length,
            dataQuads: dataQuads.length,
            generatedAt,
            durationMs: Date.now() - started,
        });
    }

    await handle.store.transaction(async tx => {
        for (const { scope, quads } of perScope) {
            await tx.load(quads, namedNode(scope.inferredGraph), { replace: true });
        }
    });
    return summaries;
}

export interface ReasoningStatus {
    scope: ReasoningScopeId;
    graph: string;
    /** Abgeleitete Tripel im Graphen (ohne PROV-Buchführung). */
    inferred: number;
    generatedAt?: string;
}

/** Zustand der Inferenz-Graphen (für UI/API), ohne einen Lauf auszulösen. */
export async function reasoningStatus(handle: GraphHandle): Promise<ReasoningStatus[]> {
    const existing = (await handle.store.graphs()).map(g => g.value);
    const out: ReasoningStatus[] = [];
    for (const scope of reasoningScopes(handle.iri, existing)) {
        const quads = existing.includes(scope.inferredGraph)
            ? await collect(handle.store, scope.inferredGraph)
            : [];
        const activityIri = handle.iri.entity('activity', `reasoning-${scope.scope}`);
        const generatedAt = quads.find(q =>
            q.subject.termType === 'NamedNode' && q.subject.value === scope.inferredGraph &&
            q.predicate.value === PROV.generatedAtTime,
        )?.object.value;
        // Buchführung = Aussagen ÜBER den Graphen bzw. den Lauf selbst.
        const bookkeeping = quads.filter(q =>
            q.subject.termType === 'NamedNode' &&
            (q.subject.value === scope.inferredGraph || q.subject.value === activityIri),
        ).length;
        out.push({
            scope: scope.scope,
            graph: scope.inferredGraph,
            inferred: Math.max(0, quads.length - bookkeeping),
            generatedAt,
        });
    }
    return out;
}

/** Abgeleitete Tripel eines Scopes (ohne PROV-Buchführung), gekappt. */
export async function inferredTriples(
    handle: GraphHandle,
    scope: ReasoningScopeId,
    limit = 2000,
): Promise<Array<{ subject: string; predicate: string; object: string }>> {
    const graphIri = handle.iri.inferredGraph(scope);
    const activityIri = handle.iri.entity('activity', `reasoning-${scope}`);
    const out: Array<{ subject: string; predicate: string; object: string }> = [];
    for await (const q of handle.store.dump(namedNode(graphIri))) {
        if (q.subject.termType === 'NamedNode' && (q.subject.value === graphIri || q.subject.value === activityIri)) continue;
        if (q.subject.termType !== 'NamedNode' || q.predicate.termType !== 'NamedNode') continue;
        out.push({ subject: q.subject.value, predicate: q.predicate.value, object: q.object.value });
        if (out.length >= limit) break;
    }
    return out;
}

// --- SHACL über Store-Graphen (Stellen 2 und 3 aus §7.2) -----------------

export interface StoreValidationReport extends ShaclReport {
    /** Tatsächlich validierte Graphen. */
    graphs: string[];
}

/**
 * On-demand-Validierung (Explorer, §7.2 Stelle 3) und Grundlage der
 * Post-Pull-Validierung: prüft die angeforderten Wissens-Graphen gegen
 * graph/shapes. Nicht angeforderte oder nicht erlaubte Graphen
 * (acl, presentation, inferred, vocab, shapes) werden still verworfen.
 */
export async function validateStoreGraphs(handle: GraphHandle, graphIris?: string[]): Promise<StoreValidationReport> {
    const existing = (await handle.store.graphs()).map(g => g.value);
    // Kausalmodelle sind validierbar, aber kein Reasoning-Eingang
    // (CAUSAL_LAYER_SPEC §5.1): Die Shapes für kausale Kanten wären
    // wertlos, wenn der einzige Graph, in dem solche Kanten vorkommen,
    // von der Validierung ausgenommen bliebe. Aus dem OWL-RL-Lauf bleiben
    // sie trotzdem draußen — eine Annahme ist kein Axiom.
    const allowed = [
        ...workspaceScopeGraphs(handle.iri, existing),
        ...causalGraphsOf(handle.iri, existing).map(ref => ref.graph),
        ...existing.filter(g => g === handle.iri.graph('causal-hypotheses')),
    ].sort();
    const graphs = (graphIris && graphIris.length > 0
        ? graphIris.filter(g => allowed.includes(g))
        : allowed);
    const shapesQuads = await collect(handle.store, handle.iri.sharedGraph('shapes'));
    const dataQuads: Quad[] = [];
    for (const graphIri of graphs) {
        dataQuads.push(...await collect(handle.store, graphIri));
    }
    const report = await validateQuads(shapesQuads, dataQuads);
    return { ...report, graphs };
}

// --- Validierungsbericht eines Connector-Laufs in graph/meta -------------

/** Stabile IRI des sh:ValidationReport einer Connector-Instanz. */
export function connectorValidationIri(iri: IriFactory, connectorId: string): string {
    return iri.entity('activity', `validation-${connectorId}`);
}

/**
 * Ersetzt den Validierungsbericht eines Connectors in `graph/meta`
 * (§7.2: „Bericht als Graph" nach jedem Pull). Läuft auf dem übergebenen
 * Store — innerhalb einer Transaktion ist das die tx-Sicht.
 */
export async function saveConnectorValidationReport(
    handle: GraphHandle,
    connectorId: string,
    report: ShaclReport,
    generatedAtIso: string,
): Promise<void> {
    const metaGraph = namedNode(handle.iri.sharedGraph('meta'));
    const reportIri = connectorValidationIri(handle.iri, connectorId);
    const remaining: Quad[] = [];
    for await (const q of handle.store.dump(metaGraph)) {
        if (q.subject.termType === 'NamedNode' &&
            (q.subject.value === reportIri || q.subject.value.startsWith(`${reportIri}/`))) {
            continue;
        }
        remaining.push(q);
    }
    const next = [...remaining, ...reportQuads(report, reportIri, metaGraph.value, generatedAtIso)];
    await handle.store.load(next, metaGraph, { replace: true });
}

/** Entfernt den Validierungsbericht eines Connectors (beim Löschen). */
export async function removeConnectorValidationReport(handle: GraphHandle, connectorId: string): Promise<void> {
    const metaGraph = namedNode(handle.iri.sharedGraph('meta'));
    const reportIri = connectorValidationIri(handle.iri, connectorId);
    const remaining: Quad[] = [];
    let removed = false;
    for await (const q of handle.store.dump(metaGraph)) {
        if (q.subject.termType === 'NamedNode' &&
            (q.subject.value === reportIri || q.subject.value.startsWith(`${reportIri}/`))) {
            removed = true;
            continue;
        }
        remaining.push(q);
    }
    if (removed) {
        await handle.store.load(remaining, metaGraph, { replace: true });
    }
}
