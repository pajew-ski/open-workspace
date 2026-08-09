/**
 * Index-Cache der Graph-Suche (M8).
 *
 * Volltext- und Vektorindex sind aus dem Store reproduzierbar und werden
 * deshalb NIE persistiert (dieselbe Linie wie graph/inferred, SPEC §8.1) —
 * sie leben pro Prozess in einem WeakMap-Cache am Store und werden nach
 * jeder Mutation invalidiert (server/instance.ts ruft
 * `invalidateSearchIndexes` im prozessweiten Mutations-Pfad auf; die
 * SPARQL-Update-Route zusätzlich, weil sie am Mutations-Pfad vorbeiläuft).
 *
 * Der Volltext-Index wird pro Graph-Menge gebaut (Schlüssel = sortierte
 * Graph-IRIs): damit ist er inhärent scope-partitioniert (§17.4) — ein
 * Index enthält nie Literale außerhalb des Datasets, für das er gebaut
 * wurde.
 */

import type { GraphStore } from '../store/types';
import { FulltextIndex } from './fulltext';
import { buildFulltextIndexForGraphs, type GraphHandle } from './retrieval';
import { buildVectorIndex, embeddingTextForNode, VectorIndex, type EmbeddingProvider } from './vector';
import { LABEL_PREDICATES } from './fulltext';
import { namedNode } from '../rdf';
import { SCHEMA } from '../vocab';

interface StoreSearchState {
    fulltextByDataset: Map<string, Promise<FulltextIndex>>;
    vectorByDataset: Map<string, Promise<VectorIndex>>;
    /** Text-Hash → Vektor: unveränderte Texte werden nie doppelt eingebettet. */
    embeddingCache: Map<string, number[]>;
}

const states = new WeakMap<GraphStore, StoreSearchState>();

function stateFor(store: GraphStore): StoreSearchState {
    let state = states.get(store);
    if (!state) {
        state = { fulltextByDataset: new Map(), vectorByDataset: new Map(), embeddingCache: new Map() };
        states.set(store, state);
    }
    return state;
}

function datasetKey(graphs: readonly string[]): string {
    return [...graphs].sort().join('\n');
}

/** Nach jeder Store-Mutation aufrufen — Indizes werden lazy neu gebaut. */
export function invalidateSearchIndexes(store: GraphStore): void {
    const state = states.get(store);
    if (!state) return;
    state.fulltextByDataset.clear();
    state.vectorByDataset.clear();
    // embeddingCache bleibt: er ist über den Text-Hash adressiert und
    // damit gegen veraltete Inhalte immun — nur unveränderte Texte treffen.
}

/** Gecachter Volltext-Index über genau diese Graph-Menge. */
export function getFulltextIndex(handle: GraphHandle, graphs: readonly string[]): Promise<FulltextIndex> {
    const state = stateFor(handle.store);
    const key = datasetKey(graphs);
    let cached = state.fulltextByDataset.get(key);
    if (!cached) {
        cached = buildFulltextIndexForGraphs(handle, graphs);
        cached.catch(() => state.fulltextByDataset.delete(key));
        state.fulltextByDataset.set(key, cached);
    }
    return cached;
}

/**
 * Gecachter Vektorindex über diese Graph-Menge. Baut Embedding-Texte aus
 * Label + schema:description/schema:text pro Subjekt; jeder Vektor trägt
 * die Subjekt-IRI (SPEC §7.7). Nur mit konfiguriertem Provider aufrufbar.
 */
export function getVectorIndex(
    handle: GraphHandle,
    graphs: readonly string[],
    provider: EmbeddingProvider,
): Promise<VectorIndex> {
    const state = stateFor(handle.store);
    const key = `${provider.model}\n${datasetKey(graphs)}`;
    let cached = state.vectorByDataset.get(key);
    if (!cached) {
        cached = buildVectorIndexForGraphs(handle, graphs, provider, state.embeddingCache);
        cached.catch(() => state.vectorByDataset.delete(key));
        state.vectorByDataset.set(key, cached);
    }
    return cached;
}

async function buildVectorIndexForGraphs(
    handle: GraphHandle,
    graphs: readonly string[],
    provider: EmbeddingProvider,
    cache: Map<string, number[]>,
): Promise<VectorIndex> {
    interface NodeTexts {
        graph: string;
        label?: string;
        texts: string[];
    }
    const byIri = new Map<string, NodeTexts>();
    for (const graph of [...graphs].sort()) {
        for await (const q of handle.store.dump(namedNode(graph))) {
            if (q.subject.termType !== 'NamedNode' || q.object.termType !== 'Literal') continue;
            const value = q.object.value.trim();
            if (value === '') continue;
            let entry = byIri.get(q.subject.value);
            if (!entry) {
                entry = { graph, texts: [] };
                byIri.set(q.subject.value, entry);
            }
            if (LABEL_PREDICATES.has(q.predicate.value)) {
                if (!entry.label) entry.label = value;
            } else if (q.predicate.value === SCHEMA.description || q.predicate.value === SCHEMA.text) {
                entry.texts.push(value);
            }
        }
    }
    const nodes = [...byIri.entries()]
        .map(([iri, entry]) => ({
            iri,
            graph: entry.graph,
            text: embeddingTextForNode({ label: entry.label, texts: entry.texts.sort() }),
        }))
        .filter(node => node.text !== '')
        .sort((a, b) => a.iri.localeCompare(b.iri));
    return buildVectorIndex(nodes, provider, cache);
}
