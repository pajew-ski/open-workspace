/**
 * Term-Konvertierung zwischen @rdfjs/types und den Oxigraph-WASM-Klassen.
 *
 * Oxigraph akzeptiert nur seine eigenen Term-Instanzen; nach außen sind
 * seine Terme strukturell RDF/JS-kompatibel. Die Rückrichtung ist deshalb
 * eine typisierte Identität (ein Cast an genau einer Stelle, durch
 * Struktur-Tests abgesichert), die Hinrichtung ein rekursiver Neubau.
 */

import {
    blankNode as oxBlankNode,
    defaultGraph as oxDefaultGraph,
    literal as oxLiteral,
    namedNode as oxNamedNode,
    quad as oxQuad,
    triple as oxTriple,
    type Quad as OxQuad,
    type Quad_Graph as OxGraph,
    type Quad_Object as OxObject,
    type Quad_Subject as OxSubject,
    type NamedNode as OxNamedNode,
    type Term as OxTerm,
} from 'oxigraph';
import type { NamedNode, Quad, Quad_Graph, Term } from '@rdfjs/types';

export function toOxNamedNode(term: NamedNode): OxNamedNode {
    return oxNamedNode(term.value);
}

function toOxSubject(term: Quad['subject']): OxSubject {
    switch (term.termType) {
        case 'NamedNode': return oxNamedNode(term.value);
        case 'BlankNode': return oxBlankNode(term.value);
        case 'Quad': return toOxTriple(term);
        case 'Variable': throw new Error('Variablen sind in gespeicherten Quads nicht erlaubt.');
    }
}

function toOxObject(term: Quad['object']): OxObject {
    switch (term.termType) {
        case 'NamedNode': return oxNamedNode(term.value);
        case 'BlankNode': return oxBlankNode(term.value);
        case 'Quad': return toOxTriple(term);
        case 'Literal': {
            if (term.language) {
                return term.direction
                    ? oxLiteral(term.value, { language: term.language, direction: term.direction })
                    : oxLiteral(term.value, term.language);
            }
            return oxLiteral(term.value, oxNamedNode(term.datatype.value));
        }
        case 'Variable': throw new Error('Variablen sind in gespeicherten Quads nicht erlaubt.');
    }
}

function toOxTriple(term: Quad): OxQuad {
    return oxTriple(
        toOxSubject(term.subject),
        oxNamedNode(term.predicate.value),
        toOxObject(term.object),
    );
}

export function toOxGraph(term: Quad_Graph): OxGraph {
    switch (term.termType) {
        case 'DefaultGraph': return oxDefaultGraph();
        case 'NamedNode': return oxNamedNode(term.value);
        case 'BlankNode': return oxBlankNode(term.value);
        case 'Variable': throw new Error('Variablen sind in gespeicherten Quads nicht erlaubt.');
    }
}

/** Konvertiert ein RDF/JS-Quad; `graphOverride` erzwingt den Ziel-Graphen. */
export function toOxQuad(q: Quad, graphOverride?: OxGraph): OxQuad {
    return oxQuad(
        toOxSubject(q.subject),
        oxNamedNode(q.predicate.value),
        toOxObject(q.object),
        graphOverride ?? toOxGraph(q.graph),
    );
}

/**
 * Oxigraph-Terme sind strukturell RDF/JS-konform (termType, value,
 * language/datatype/direction, equals). Der Cast ist die einzige Stelle,
 * an der die beiden Typwelten zusammengeführt werden; die Struktur wird
 * in tests/graph/store.test.ts abgesichert.
 */
export function fromOxQuad(q: OxQuad): Quad {
    return q as unknown as Quad;
}

export function fromOxTerm(term: OxTerm): Term {
    return term as unknown as Term;
}
