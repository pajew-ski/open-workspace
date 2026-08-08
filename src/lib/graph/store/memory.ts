/**
 * In-Memory-Test-Double des GraphStore (SPEC §5.1).
 *
 * Für Tests von Serialisierung, Migration und Connectors, die keinen
 * SPARQL-Motor brauchen. query()/update() werfen ehrlich NOT_SUPPORTED —
 * kein stiller Teil-SPARQL, der in Tests etwas anderes prüft als in
 * Produktion läuft (Invariante 10: keine Attrappen).
 */

import type { NamedNode, Quad } from '@rdfjs/types';
import { GraphStoreError } from './types';
import type { GraphStore, LoadReport, QueryOptions, QueryResult } from './types';
import { quadToNQuadsLine } from '../serialize/nquads';
import { factory } from '../rdf';

export class MemoryGraphStore implements GraphStore {
    /** Quads, gekeyt über ihre N-Quads-Zeile (dedupe wie ein echter Store). */
    private quads = new Map<string, Quad>();

    async query(sparql: string, opts?: QueryOptions): Promise<QueryResult> {
        void opts;
        throw new GraphStoreError(
            `MemoryGraphStore unterstützt kein SPARQL — nimm OxigraphStore. (Query war: ${sparql.slice(0, 80)}…)`,
            'NOT_SUPPORTED',
        );
    }

    async update(sparql: string, opts?: QueryOptions): Promise<void> {
        void opts;
        throw new GraphStoreError(
            `MemoryGraphStore unterstützt kein SPARQL — nimm OxigraphStore. (Update war: ${sparql.slice(0, 80)}…)`,
            'NOT_SUPPORTED',
        );
    }

    async load(
        quads: AsyncIterable<Quad> | Iterable<Quad>,
        graph: NamedNode,
        opts?: { replace?: boolean },
    ): Promise<LoadReport> {
        let removed = 0;
        if (opts?.replace) {
            for (const [key, q] of this.quads) {
                if (q.graph.termType === 'NamedNode' && q.graph.value === graph.value) {
                    this.quads.delete(key);
                    removed += 1;
                }
            }
        }
        let added = 0;
        const push = (q: Quad) => {
            const rebased = factory.quad(q.subject, q.predicate, q.object, graph);
            const key = quadToNQuadsLine(rebased);
            if (!this.quads.has(key)) {
                this.quads.set(key, rebased);
                added += 1;
            }
        };
        if (Symbol.asyncIterator in Object(quads)) {
            for await (const q of quads as AsyncIterable<Quad>) push(q);
        } else {
            for (const q of quads as Iterable<Quad>) push(q);
        }
        return { added, removed, graph };
    }

    async *dump(graph?: NamedNode): AsyncIterable<Quad> {
        for (const q of this.quads.values()) {
            if (!graph || (q.graph.termType === 'NamedNode' && q.graph.value === graph.value)) {
                yield q;
            }
        }
    }

    async graphs(): Promise<NamedNode[]> {
        const iris = new Set<string>();
        for (const q of this.quads.values()) {
            if (q.graph.termType === 'NamedNode') {
                iris.add(q.graph.value);
            }
        }
        return [...iris].sort().map(iri => factory.namedNode(iri));
    }

    async transaction<T>(fn: (tx: GraphStore) => Promise<T>): Promise<T> {
        const snapshot = new Map(this.quads);
        try {
            return await fn(this);
        } catch (error) {
            this.quads = snapshot;
            throw error;
        }
    }

    async close(): Promise<void> {
        this.quads.clear();
    }
}
