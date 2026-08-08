/**
 * N-Quads-Serialisierung (RDF 1.2, inkl. Triple Terms).
 *
 * Eigener Writer statt Store-Dump, weil die deterministische
 * Serialisierung (SPEC §8.1) eine stabile, kanonisch sortierbare
 * Zeilenform pro Quad braucht — unabhängig davon, in welchem Store die
 * Quads gerade liegen.
 */

import type { Quad, Term } from '@rdfjs/types';
import { XSD, PREFIXES } from '../vocab';

const XSD_STRING = XSD.string;
const RDF_LANG_STRING = `${PREFIXES.rdf}langString`;

/** Escaping nach N-Triples/N-Quads-Grammatik (ECHAR). */
export function escapeLiteral(value: string): string {
    let out = '';
    for (const ch of value) {
        switch (ch) {
            case '\\': out += '\\\\'; break;
            case '"': out += '\\"'; break;
            case '\n': out += '\\n'; break;
            case '\r': out += '\\r'; break;
            case '\t': out += '\\t'; break;
            case '\b': out += '\\b'; break;
            case '\f': out += '\\f'; break;
            default: out += ch;
        }
    }
    return out;
}

/** Serialisiert einen Term in N-Quads-Syntax. Triple Terms als `<<( … )>>`. */
export function termToNQuads(term: Term): string {
    switch (term.termType) {
        case 'NamedNode':
            return `<${term.value}>`;
        case 'BlankNode':
            return `_:${term.value}`;
        case 'Literal': {
            const lex = `"${escapeLiteral(term.value)}"`;
            if (term.language) {
                const dir = term.direction ? `--${term.direction}` : '';
                return `${lex}@${term.language}${dir}`;
            }
            if (term.datatype.value !== XSD_STRING && term.datatype.value !== RDF_LANG_STRING) {
                return `${lex}^^<${term.datatype.value}>`;
            }
            return lex;
        }
        case 'DefaultGraph':
            return '';
        case 'Variable':
            return `?${term.value}`;
        case 'Quad': {
            const q = term as Quad;
            return `<<( ${termToNQuads(q.subject)} ${termToNQuads(q.predicate)} ${termToNQuads(q.object)} )>>`;
        }
    }
}

/** Eine N-Quads-Zeile inklusive Graph-Komponente und Punkt, ohne Newline. */
export function quadToNQuadsLine(q: Quad): string {
    const graph = q.graph.termType === 'DefaultGraph' ? '' : ` ${termToNQuads(q.graph)}`;
    return `${termToNQuads(q.subject)} ${termToNQuads(q.predicate)} ${termToNQuads(q.object)}${graph} .`;
}

/** Enthält der Term (rekursiv) einen Blank Node? */
export function containsBlankNode(term: Term): boolean {
    if (term.termType === 'BlankNode') return true;
    if (term.termType === 'Quad') {
        const q = term as Quad;
        return containsBlankNode(q.subject) || containsBlankNode(q.object) || containsBlankNode(q.graph);
    }
    return false;
}

export function quadContainsBlankNode(q: Quad): boolean {
    return containsBlankNode(q.subject) || containsBlankNode(q.object) || containsBlankNode(q.graph);
}

/** Enthält der Term (rekursiv) einen Triple Term (RDF 1.2)? */
export function containsTripleTerm(term: Term): boolean {
    if (term.termType === 'Quad') return true;
    return false;
}

export function quadContainsTripleTerm(q: Quad): boolean {
    return containsTripleTerm(q.subject) || containsTripleTerm(q.object);
}
