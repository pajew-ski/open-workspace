/**
 * RDF-Terme über eine Worker-Grenze (SPEC §5.2, M12).
 *
 * `postMessage` klont strukturiert — Klassen-Instanzen kommen als nackte
 * Objekte ohne `equals()` an, und RDF-1.2-Triple-Terme sind verschachtelt.
 * Deshalb eine eigene, kleine Kodierung plus eine minimale Term-Fabrik auf
 * der Empfängerseite.
 *
 * Warum keine Bibliothek und kein N-Quads-Umweg: Der Sinn des Workers ist,
 * dass der Haupt-Thread den Store NICHT lädt. Ein Parser auf der
 * Empfängerseite hieße Oxigraph-WASM im Haupt-Thread — genau das, was
 * vermieden werden soll.
 */

import type { BlankNode, DefaultGraph, Literal, NamedNode, Quad, Term, Variable } from '@rdfjs/types';

export type EncodedTerm =
    | { t: 'NamedNode'; v: string }
    | { t: 'BlankNode'; v: string }
    | { t: 'Literal'; v: string; datatype: string; language: string; direction?: 'ltr' | 'rtl' }
    | { t: 'DefaultGraph' }
    | { t: 'Variable'; v: string }
    | { t: 'Quad'; s: EncodedTerm; p: EncodedTerm; o: EncodedTerm; g: EncodedTerm };

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';

export function encodeTerm(term: Term): EncodedTerm {
    switch (term.termType) {
        case 'NamedNode': return { t: 'NamedNode', v: term.value };
        case 'BlankNode': return { t: 'BlankNode', v: term.value };
        case 'DefaultGraph': return { t: 'DefaultGraph' };
        case 'Variable': return { t: 'Variable', v: term.value };
        case 'Literal': {
            const literal = term as Literal;
            return {
                t: 'Literal',
                v: literal.value,
                datatype: literal.datatype?.value ?? XSD_STRING,
                language: literal.language ?? '',
                ...(literal.direction ? { direction: literal.direction } : {}),
            };
        }
        case 'Quad': {
            const quad = term as Quad;
            return {
                t: 'Quad',
                s: encodeTerm(quad.subject),
                p: encodeTerm(quad.predicate),
                o: encodeTerm(quad.object),
                g: encodeTerm(quad.graph),
            };
        }
    }
}

export function encodeQuad(quad: Quad): EncodedTerm {
    return encodeTerm(quad);
}

/* --- Minimale Term-Fabrik (RDF/JS-konform, ohne Abhängigkeit) --------- */

function equals(self: Term, other?: Term | null): boolean {
    if (!other || other.termType !== self.termType) return false;
    if (self.termType === 'DefaultGraph') return true;
    if (self.termType === 'Quad') {
        const a = self as Quad;
        const b = other as Quad;
        return a.subject.equals(b.subject)
            && a.predicate.equals(b.predicate)
            && a.object.equals(b.object)
            && a.graph.equals(b.graph);
    }
    if (self.termType === 'Literal') {
        const a = self as Literal;
        const b = other as Literal;
        return a.value === b.value && a.language === b.language && a.datatype.value === b.datatype.value;
    }
    return self.value === other.value;
}

function namedNode(value: string): NamedNode {
    const term = { termType: 'NamedNode' as const, value, equals: (other?: Term | null) => equals(term, other) };
    return term;
}

function blankNode(value: string): BlankNode {
    const term = { termType: 'BlankNode' as const, value, equals: (other?: Term | null) => equals(term, other) };
    return term;
}

function defaultGraph(): DefaultGraph {
    const term = { termType: 'DefaultGraph' as const, value: '' as const, equals: (other?: Term | null) => equals(term, other) };
    return term;
}

function variable(value: string): Variable {
    const term = { termType: 'Variable' as const, value, equals: (other?: Term | null) => equals(term, other) };
    return term;
}

function literal(value: string, datatype: string, language: string, direction?: 'ltr' | 'rtl'): Literal {
    const term = {
        termType: 'Literal' as const,
        value,
        language,
        direction: direction ?? ('' as const),
        datatype: namedNode(language ? RDF_LANG_STRING : datatype),
        equals: (other?: Term | null) => equals(term as unknown as Term, other),
    };
    return term as unknown as Literal;
}

export function decodeTerm(encoded: EncodedTerm): Term {
    switch (encoded.t) {
        case 'NamedNode': return namedNode(encoded.v);
        case 'BlankNode': return blankNode(encoded.v);
        case 'DefaultGraph': return defaultGraph();
        case 'Variable': return variable(encoded.v);
        case 'Literal': return literal(encoded.v, encoded.datatype, encoded.language, encoded.direction);
        case 'Quad': {
            const quad = {
                termType: 'Quad' as const,
                value: '' as const,
                subject: decodeTerm(encoded.s) as Quad['subject'],
                predicate: decodeTerm(encoded.p) as Quad['predicate'],
                object: decodeTerm(encoded.o) as Quad['object'],
                graph: decodeTerm(encoded.g) as Quad['graph'],
                equals: (other?: Term | null) => equals(quad as unknown as Term, other),
            };
            return quad as unknown as Quad;
        }
    }
}

export function decodeQuad(encoded: EncodedTerm): Quad {
    const term = decodeTerm(encoded);
    if (term.termType !== 'Quad') {
        throw new Error(`Erwartet wurde ein Quad, empfangen: ${term.termType}.`);
    }
    return term as Quad;
}
