/**
 * Oxigraph-Implementierung des GraphStore (SPEC §5.1).
 *
 * Oxigraph (WASM) liefert vollständiges SPARQL 1.1 Query + Update,
 * RDF 1.2 / RDF-star und den Quad-Store — identisch in Browser und Node.
 * Entscheidungsgrundlage mit Messwerten: docs/decisions/0001-graph-store.md
 *
 * Schreiboperationen (update/load/transaction) laufen durch eine Mutex:
 * Der Store ist single-writer (SPEC §15). Lesepfade sind lockfrei.
 */

import { Store as OxStore, defaultGraph as oxDefaultGraph } from 'oxigraph';
import type { NamedNode, Quad, Term } from '@rdfjs/types';
import { GraphStoreError } from './types';
import type { GraphStore, LoadReport, QueryOptions, QueryResult } from './types';
import { fromOxQuad, toOxNamedNode } from './ox-terms';
import { termToNQuads } from '../serialize/nquads';

/** Erkennung der Query-Form für die Ergebnistypisierung leerer Resultate. */
function detectQueryForm(sparql: string): 'select' | 'construct' | 'ask' | 'describe' | 'update' | 'unknown' {
    const withoutIris = sparql.replace(/<[^>]*>/g, '<>');
    const withoutComments = withoutIris.replace(/#[^\n]*/g, '');
    const match = withoutComments.match(
        /\b(SELECT|CONSTRUCT|ASK|DESCRIBE|INSERT|DELETE|LOAD|CLEAR|CREATE|DROP|COPY|MOVE|ADD|WITH)\b/i,
    );
    if (!match) return 'unknown';
    const keyword = match[1].toUpperCase();
    if (keyword === 'SELECT') return 'select';
    if (keyword === 'CONSTRUCT') return 'construct';
    if (keyword === 'ASK') return 'ask';
    if (keyword === 'DESCRIBE') return 'describe';
    return 'update';
}

/** Variablennamen aus einer SELECT-Klausel, für leere Ergebnisse. */
function selectVariables(sparql: string): string[] {
    const match = sparql.match(/\bSELECT\b(?:\s+(?:DISTINCT|REDUCED))?\s+([^{]+)\{?/i);
    if (!match) return [];
    const clause = match[1];
    if (clause.includes('*')) return [];
    const vars = new Set<string>();
    for (const m of clause.matchAll(/[?$]([A-Za-z0-9_]+)/g)) {
        vars.add(m[1]);
    }
    return [...vars];
}

async function* toAsyncIterable<T>(items: T[]): AsyncIterable<T> {
    for (const item of items) {
        yield item;
    }
}

/** Einfache FIFO-Mutex für Schreibpfade. */
class Mutex {
    private tail: Promise<void> = Promise.resolve();

    async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
        const previous = this.tail;
        let release: () => void = () => undefined;
        this.tail = new Promise<void>(resolve => {
            release = resolve;
        });
        await previous;
        try {
            return await fn();
        } finally {
            release();
        }
    }
}

const LOAD_BATCH_SIZE = 20_000;

export class OxigraphStore implements GraphStore {
    private store: OxStore;
    private readonly mutex = new Mutex();
    private closed = false;

    constructor(initial?: OxStore) {
        this.store = initial ?? new OxStore();
    }

    /** Anzahl Quads — für Diagnostik und Tests. */
    get size(): number {
        return this.store.size;
    }

    private assertOpen(): void {
        if (this.closed) {
            throw new GraphStoreError('Store ist geschlossen.', 'NOT_SUPPORTED');
        }
    }

    async query(sparql: string, opts?: QueryOptions): Promise<QueryResult> {
        this.assertOpen();
        const form = detectQueryForm(sparql);
        if (form === 'update') {
            throw new GraphStoreError(
                'query() führt keine Updates aus — benutze update().',
                'READ_ONLY',
            );
        }
        const started = Date.now();
        let raw: boolean | Map<string, Term>[] | Quad[] | string;
        try {
            raw = this.store.query(sparql, {
                base_iri: opts?.baseIri,
                default_graph: opts?.defaultGraphs?.map(toOxNamedNode),
                named_graphs: opts?.namedGraphs?.map(toOxNamedNode),
            }) as boolean | Map<string, Term>[] | Quad[] | string;
        } catch (error) {
            throw new GraphStoreError(
                `SPARQL-Query fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
                'QUERY_FAILED',
            );
        }
        // Oxigraph-WASM ist synchron; ein weiches Zeitbudget kann nur nach
        // der Ausführung festgestellt werden (siehe QueryOptions.timeoutMs).
        if (opts?.timeoutMs !== undefined && Date.now() - started > opts.timeoutMs) {
            throw new GraphStoreError(
                `Query hat das Zeitbudget von ${opts.timeoutMs} ms überschritten.`,
                'TIMEOUT',
            );
        }

        if (typeof raw === 'boolean') {
            return { type: 'boolean', value: raw };
        }
        if (Array.isArray(raw)) {
            if (raw.length === 0) {
                return form === 'select'
                    ? { type: 'bindings', variables: selectVariables(sparql), bindings: toAsyncIterable<Record<string, Term>>([]) }
                    : { type: 'quads', quads: toAsyncIterable<Quad>([]) };
            }
            if (raw[0] instanceof Map) {
                const maps = raw as Map<string, Term>[];
                const variables = [...maps[0].keys()];
                const rows = maps.map(m => {
                    const row: Record<string, Term> = {};
                    for (const [key, value] of m) {
                        row[key] = value;
                    }
                    return row;
                });
                return { type: 'bindings', variables, bindings: toAsyncIterable(rows) };
            }
            return { type: 'quads', quads: toAsyncIterable(raw as Quad[]) };
        }
        throw new GraphStoreError('Unerwartetes Ergebnisformat der Query.', 'QUERY_FAILED');
    }

    async update(sparql: string, opts?: QueryOptions): Promise<void> {
        this.assertOpen();
        if (opts?.readOnly) {
            throw new GraphStoreError('Update im Read-Only-Modus abgelehnt.', 'READ_ONLY');
        }
        await this.mutex.runExclusive(async () => {
            try {
                this.store.update(sparql, { base_iri: opts?.baseIri });
            } catch (error) {
                throw new GraphStoreError(
                    `SPARQL-Update fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
                    'UPDATE_FAILED',
                );
            }
            this.rejectDefaultGraphWrites();
        });
    }

    /**
     * Invariante 4: Es gibt keinen Default-Graph-Schreibpfad. Der
     * Default-Graph ist vor jedem Update leer; alles, was ein Update dort
     * hinterlässt, wird entfernt und als Fehler gemeldet.
     */
    private rejectDefaultGraphWrites(): void {
        const offenders = this.store.match(null, null, null, oxDefaultGraph());
        if (offenders.length === 0) return;
        for (const q of offenders) {
            this.store.delete(q);
        }
        throw new GraphStoreError(
            `Update hat ${offenders.length} Quad(s) in den Default-Graphen geschrieben. ` +
            'Jedes Tripel braucht einen Named Graph (GRAPH-Klausel oder WITH).',
            'DEFAULT_GRAPH_WRITE',
        );
    }

    async load(
        quads: AsyncIterable<Quad> | Iterable<Quad>,
        graph: NamedNode,
        opts?: { replace?: boolean },
    ): Promise<LoadReport> {
        this.assertOpen();
        return this.mutex.runExclusive(() => this.loadUnlocked(quads, graph, opts));
    }

    private async loadUnlocked(
        quads: AsyncIterable<Quad> | Iterable<Quad>,
        graph: NamedNode,
        opts?: { replace?: boolean },
    ): Promise<LoadReport> {
        const oxGraph = toOxNamedNode(graph);
        let removed = 0;
        if (opts?.replace) {
            const existing = this.store.match(null, null, null, oxGraph);
            removed = existing.length;
            for (const q of existing) {
                this.store.delete(q);
            }
        }
        const sizeBefore = this.store.size;
        // Bulk-Load über N-Quads-Serialisierung: um Größenordnungen
        // schneller als add() pro Quad über die WASM-Grenze (Messwerte in
        // docs/decisions/0001-graph-store.md). to_graph_name erzwingt den
        // Ziel-Graphen für jede Zeile.
        let batch: string[] = [];
        const flush = () => {
            if (batch.length === 0) return;
            this.store.load(batch.join('\n'), {
                format: 'application/n-triples',
                to_graph_name: oxGraph,
            });
            batch = [];
        };
        const push = (q: Quad) => {
            // Graph-Komponente wird verworfen — der Ziel-Graph kommt vom
            // Aufrufer (to_graph_name), Provenienz ist strukturell erzwungen.
            batch.push(`${termToNQuads(q.subject)} ${termToNQuads(q.predicate)} ${termToNQuads(q.object)} .`);
            if (batch.length >= LOAD_BATCH_SIZE) flush();
        };
        if (Symbol.asyncIterator in Object(quads)) {
            for await (const q of quads as AsyncIterable<Quad>) push(q);
        } else {
            for (const q of quads as Iterable<Quad>) push(q);
        }
        flush();
        return { added: this.store.size - sizeBefore, removed, graph };
    }

    async *dump(graph?: NamedNode): AsyncIterable<Quad> {
        this.assertOpen();
        const matches = graph
            ? this.store.match(null, null, null, toOxNamedNode(graph))
            : this.store.match(null, null, null, null);
        for (const q of matches) {
            yield fromOxQuad(q);
        }
    }

    async graphs(): Promise<NamedNode[]> {
        this.assertOpen();
        const result = await this.query('SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }');
        if (result.type !== 'bindings') return [];
        const graphs: NamedNode[] = [];
        for await (const row of result.bindings) {
            const term = row.g;
            if (term && term.termType === 'NamedNode') {
                graphs.push(term);
            }
        }
        return graphs.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
    }

    async transaction<T>(fn: (tx: GraphStore) => Promise<T>): Promise<T> {
        this.assertOpen();
        return this.mutex.runExclusive(async () => {
            const snapshot = this.store.dump({ format: 'application/n-quads' });
            const view = new TransactionView(this);
            try {
                return await fn(view);
            } catch (error) {
                const restored = new OxStore();
                if (snapshot.length > 0) {
                    restored.load(snapshot, { format: 'application/n-quads' });
                }
                this.store = restored;
                throw error instanceof GraphStoreError
                    ? error
                    : new GraphStoreError(
                        `Transaktion zurückgerollt: ${error instanceof Error ? error.message : String(error)}`,
                        'TRANSACTION_FAILED',
                    );
            } finally {
                view.invalidate();
            }
        });
    }

    async close(): Promise<void> {
        this.closed = true;
    }

    // --- Unlocked-Zugriffe für die Transaktions-Sicht -------------------

    queryUnlocked(sparql: string, opts?: QueryOptions): Promise<QueryResult> {
        return this.query(sparql, opts);
    }

    updateUnlocked(sparql: string, opts?: QueryOptions): void {
        if (opts?.readOnly) {
            throw new GraphStoreError('Update im Read-Only-Modus abgelehnt.', 'READ_ONLY');
        }
        try {
            this.store.update(sparql, { base_iri: opts?.baseIri });
        } catch (error) {
            throw new GraphStoreError(
                `SPARQL-Update fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
                'UPDATE_FAILED',
            );
        }
        this.rejectDefaultGraphWrites();
    }

    loadUnlockedForTx(
        quads: AsyncIterable<Quad> | Iterable<Quad>,
        graph: NamedNode,
        opts?: { replace?: boolean },
    ): Promise<LoadReport> {
        return this.loadUnlocked(quads, graph, opts);
    }
}

/**
 * Sicht auf den Store innerhalb einer Transaktion: nutzt die Unlocked-
 * Pfade (die Mutex hält bereits die Transaktion) und wird nach Abschluss
 * invalidiert, damit keine Referenz die Transaktion überlebt.
 */
class TransactionView implements GraphStore {
    private valid = true;

    constructor(private readonly parent: OxigraphStore) {}

    invalidate(): void {
        this.valid = false;
    }

    private assertValid(): void {
        if (!this.valid) {
            throw new GraphStoreError('Transaktions-Sicht außerhalb der Transaktion benutzt.', 'TRANSACTION_FAILED');
        }
    }

    async query(sparql: string, opts?: QueryOptions): Promise<QueryResult> {
        this.assertValid();
        return this.parent.queryUnlocked(sparql, opts);
    }

    async update(sparql: string, opts?: QueryOptions): Promise<void> {
        this.assertValid();
        this.parent.updateUnlocked(sparql, opts);
    }

    async load(
        quads: AsyncIterable<Quad> | Iterable<Quad>,
        graph: NamedNode,
        opts?: { replace?: boolean },
    ): Promise<LoadReport> {
        this.assertValid();
        return this.parent.loadUnlockedForTx(quads, graph, opts);
    }

    dump(graph?: NamedNode): AsyncIterable<Quad> {
        this.assertValid();
        return this.parent.dump(graph);
    }

    async graphs(): Promise<NamedNode[]> {
        this.assertValid();
        return this.parent.graphs();
    }

    async transaction<T>(fn: (tx: GraphStore) => Promise<T>): Promise<T> {
        this.assertValid();
        // Verschachtelte Transaktionen laufen in der äußeren mit.
        return fn(this);
    }

    async close(): Promise<void> {
        throw new GraphStoreError('close() innerhalb einer Transaktion ist nicht erlaubt.', 'NOT_SUPPORTED');
    }
}
