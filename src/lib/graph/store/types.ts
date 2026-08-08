/**
 * GraphStore — das Store-Interface des Graph-Kerns (SPEC §5.1).
 *
 * Core-Code kennt nur dieses Interface (Invariante 7). Die einzige
 * ernstzunehmende Implementierung ist Oxigraph (WASM, identisch in
 * Browser und Node); daneben existiert ein In-Memory-Test-Double für
 * Tests, die kein SPARQL brauchen.
 */

import type { NamedNode, Quad, Term } from '@rdfjs/types';

export interface QueryOptions {
    /** Default-Dataset der Query (überschreibt FROM im Query-Text). */
    defaultGraphs?: NamedNode[];
    /** Erlaubte Named Graphs (überschreibt FROM NAMED im Query-Text). */
    namedGraphs?: NamedNode[];
    /**
     * Weiches Zeitbudget. Oxigraph-WASM arbeitet synchron und ist nicht
     * unterbrechbar; der Wert wird nach Ausführung geprüft und als
     * Überschreitung gemeldet. Harte Kappung liefert erst der
     * Worker-Betrieb der Runtime `local` bzw. der Prozess-Store.
     */
    timeoutMs?: number;
    /** Erzwingt Read-Only, auch wenn die Query ein UPDATE ist. */
    readOnly?: boolean;
    /** Basis-IRI für relative IRIs im Query-Text. */
    baseIri?: string;
}

export type QueryResult =
    | { type: 'bindings'; variables: string[]; bindings: AsyncIterable<Record<string, Term>> }
    | { type: 'quads'; quads: AsyncIterable<Quad> }
    | { type: 'boolean'; value: boolean };

export interface LoadReport {
    added: number;
    removed: number;
    graph: NamedNode;
}

export class GraphStoreError extends Error {
    constructor(message: string, readonly code:
        | 'READ_ONLY'
        | 'DEFAULT_GRAPH_WRITE'
        | 'QUERY_FAILED'
        | 'UPDATE_FAILED'
        | 'TIMEOUT'
        | 'NOT_SUPPORTED'
        | 'TRANSACTION_FAILED',
    ) {
        super(message);
        this.name = 'GraphStoreError';
    }
}

export interface GraphStore {
    /** SPARQL 1.1 Query (SELECT/CONSTRUCT/ASK/DESCRIBE). Lehnt Updates ab. */
    query(sparql: string, opts?: QueryOptions): Promise<QueryResult>;
    /**
     * SPARQL 1.1 Update. Es gibt keinen Default-Graph-Schreibpfad
     * (Invariante 4): Updates, die Quads in den Default-Graphen schreiben,
     * werden zurückgewiesen.
     */
    update(sparql: string, opts?: QueryOptions): Promise<void>;
    /**
     * Lädt Quads in genau einen Named Graph. Der Graph-Anteil der
     * Eingabe-Quads wird durch `graph` ersetzt — Provenienz ist damit
     * strukturell erzwungen. `replace: true` ersetzt den Graphen
     * vollständig (Connector-Semantik, SPEC §6.2).
     */
    load(quads: AsyncIterable<Quad> | Iterable<Quad>, graph: NamedNode, opts?: { replace?: boolean }): Promise<LoadReport>;
    /** Alle Quads (optional eines Graphen), mit Graph-Komponente. */
    dump(graph?: NamedNode): AsyncIterable<Quad>;
    /** Alle Named Graphs mit mindestens einem Quad. */
    graphs(): Promise<NamedNode[]>;
    /**
     * Serialisierte Ausführung mit Rollback: Wirft `fn`, wird der Zustand
     * vor der Transaktion wiederhergestellt. Gedacht für mehrschrittige
     * Mutationen (Connector-Replace, Migration), nicht für Lesepfade.
     */
    transaction<T>(fn: (tx: GraphStore) => Promise<T>): Promise<T>;
    close(): Promise<void>;
}
