/**
 * RDF-Ein-/Ausgabe über die Oxigraph-Parser/Serialisierer.
 *
 * Ein einziger RDF-Motor für alle Formate (Turtle, TriG, N-Triples,
 * N-Quads, JSON-LD, RDF/XML) — kein zweiter Parser-Stack. Die
 * deterministische N-Quads-Ausgabe für Git liegt bewusst NICHT hier,
 * sondern in canonical.ts.
 */

import { Store, defaultGraph as oxDefaultGraph } from 'oxigraph';
import type { Quad } from '@rdfjs/types';
import { toOxQuad, fromOxQuad } from '../store/ox-terms';

export type RdfFormat =
    | 'text/turtle'
    | 'application/n-triples'
    | 'application/n-quads'
    | 'text/trig'
    | 'application/ld+json'
    | 'application/rdf+xml';

const FORMAT_ALIASES: Record<string, RdfFormat> = {
    'text/turtle': 'text/turtle',
    turtle: 'text/turtle',
    ttl: 'text/turtle',
    'application/n-triples': 'application/n-triples',
    'n-triples': 'application/n-triples',
    nt: 'application/n-triples',
    'application/n-quads': 'application/n-quads',
    'n-quads': 'application/n-quads',
    nq: 'application/n-quads',
    'text/trig': 'text/trig',
    trig: 'text/trig',
    'application/ld+json': 'application/ld+json',
    'application/json': 'application/ld+json',
    jsonld: 'application/ld+json',
    'application/rdf+xml': 'application/rdf+xml',
    'rdf/xml': 'application/rdf+xml',
    rdfxml: 'application/rdf+xml',
};

/** Formate, deren Serialisierung keine Named Graphs tragen kann. */
const TRIPLE_ONLY_FORMATS: ReadonlySet<RdfFormat> = new Set([
    'text/turtle',
    'application/n-triples',
    'application/rdf+xml',
]);

export function normalizeRdfFormat(format: string): RdfFormat {
    const normalized = FORMAT_ALIASES[format.toLowerCase().split(';')[0].trim()];
    if (!normalized) {
        throw new Error(`Unbekanntes RDF-Format: "${format}"`);
    }
    return normalized;
}

export function isTripleOnlyFormat(format: string): boolean {
    return TRIPLE_ONLY_FORMATS.has(normalizeRdfFormat(format));
}

/**
 * Parst RDF-Text in Quads. Bei Triple-Formaten landen die Tripel im
 * Default-Graphen des Ergebnisses — der Aufrufer weist ihnen beim Laden
 * in den Store einen Named Graph zu (Invariante 4).
 */
export function parseRdf(input: string, options: { format: string; baseIri?: string }): Quad[] {
    const format = normalizeRdfFormat(options.format);
    const store = new Store();
    store.load(input, { format, base_iri: options.baseIri });
    return store.match(null, null, null, null).map(fromOxQuad);
}

/**
 * Serialisiert Quads in ein RDF-Format. Für Triple-Formate wird die
 * Graph-Komponente verworfen (Vereinigung) — der Aufrufer übergibt dafür
 * sinnvollerweise die Quads genau eines Graphen.
 */
export function serializeRdf(quads: Iterable<Quad>, format: string): string {
    const normalized = normalizeRdfFormat(format);
    const store = new Store();
    const tripleOnly = TRIPLE_ONLY_FORMATS.has(normalized);
    for (const q of quads) {
        store.add(toOxQuad(q, tripleOnly ? oxDefaultGraph() : undefined));
    }
    if (tripleOnly) {
        return store.dump({ format: normalized, from_graph_name: oxDefaultGraph() });
    }
    return store.dump({ format: normalized });
}
