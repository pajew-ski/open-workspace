/**
 * Minimale, spec-konforme RDF/JS-Term-Fabrik (@rdfjs/types).
 *
 * Pure Datenstrukturen ohne Store-Bindung: Migrator, Serialisierung und
 * Test-Double bauen Quads hierüber, ohne Oxigraph zu kennen. Der
 * Oxigraph-Store konvertiert eingehende Terme in seine WASM-Klassen.
 */

import type {
    BlankNode,
    DataFactory,
    DefaultGraph,
    Literal,
    NamedNode,
    Quad,
    Quad_Graph,
    Quad_Object,
    Quad_Predicate,
    Quad_Subject,
    Term,
} from '@rdfjs/types';
import { XSD, PREFIXES } from './vocab';

const XSD_STRING = XSD.string;
const RDF_LANG_STRING = `${PREFIXES.rdf}langString`;

function termEquals(a: Term, b: Term | null | undefined): boolean {
    if (!b) return false;
    if (a === b) return true;
    if (a.termType !== b.termType) return false;
    switch (a.termType) {
        case 'Literal': {
            const other = b as Literal;
            return (
                a.value === other.value &&
                a.language === other.language &&
                (a.direction ?? '') === (other.direction ?? '') &&
                a.datatype.value === other.datatype.value
            );
        }
        case 'Quad': {
            const other = b as Quad;
            const self = a as Quad;
            return (
                termEquals(self.subject, other.subject) &&
                termEquals(self.predicate, other.predicate) &&
                termEquals(self.object, other.object) &&
                termEquals(self.graph, other.graph)
            );
        }
        default:
            return a.value === b.value;
    }
}

class NamedNodeImpl implements NamedNode {
    readonly termType = 'NamedNode' as const;
    constructor(readonly value: string) {}
    equals(other: Term | null | undefined): boolean {
        return termEquals(this, other);
    }
}

class BlankNodeImpl implements BlankNode {
    readonly termType = 'BlankNode' as const;
    constructor(readonly value: string) {}
    equals(other: Term | null | undefined): boolean {
        return termEquals(this, other);
    }
}

class LiteralImpl implements Literal {
    readonly termType = 'Literal' as const;
    constructor(
        readonly value: string,
        readonly language: string,
        readonly datatype: NamedNode,
        readonly direction: 'ltr' | 'rtl' | '' = '',
    ) {}
    equals(other: Term | null | undefined): boolean {
        return termEquals(this, other);
    }
}

class DefaultGraphImpl implements DefaultGraph {
    readonly termType = 'DefaultGraph' as const;
    readonly value = '' as const;
    equals(other: Term | null | undefined): boolean {
        return termEquals(this, other);
    }
}

class QuadImpl implements Quad {
    readonly termType = 'Quad' as const;
    readonly value = '' as const;
    constructor(
        readonly subject: Quad_Subject,
        readonly predicate: Quad_Predicate,
        readonly object: Quad_Object,
        readonly graph: Quad_Graph,
    ) {}
    equals(other: Term | null | undefined): boolean {
        return termEquals(this, other);
    }
}

const DEFAULT_GRAPH = new DefaultGraphImpl();
let blankNodeCounter = 0;

export const factory: DataFactory = {
    namedNode: <Iri extends string = string>(value: Iri) => new NamedNodeImpl(value) as NamedNode<Iri>,
    blankNode: (value?: string) => new BlankNodeImpl(value ?? `b${(blankNodeCounter += 1)}`),
    literal: (value: string, languageOrDatatype?: string | NamedNode | { language: string; direction?: 'ltr' | 'rtl' | '' | null }) => {
        if (languageOrDatatype === undefined) {
            return new LiteralImpl(value, '', new NamedNodeImpl(XSD_STRING));
        }
        if (typeof languageOrDatatype === 'string') {
            return new LiteralImpl(value, languageOrDatatype, new NamedNodeImpl(RDF_LANG_STRING));
        }
        if ('termType' in languageOrDatatype) {
            return new LiteralImpl(value, '', languageOrDatatype);
        }
        return new LiteralImpl(
            value,
            languageOrDatatype.language,
            new NamedNodeImpl(RDF_LANG_STRING),
            languageOrDatatype.direction ?? '',
        );
    },
    variable: (value: string) => ({
        termType: 'Variable' as const,
        value,
        equals: (other: Term | null | undefined) => !!other && other.termType === 'Variable' && other.value === value,
    }),
    defaultGraph: () => DEFAULT_GRAPH,
    quad: (subject: Quad_Subject, predicate: Quad_Predicate, object: Quad_Object, graph?: Quad_Graph) =>
        new QuadImpl(subject, predicate, object, graph ?? DEFAULT_GRAPH),
    fromTerm: (original) => {
        switch (original.termType) {
            case 'NamedNode': return new NamedNodeImpl(original.value);
            case 'BlankNode': return new BlankNodeImpl(original.value);
            case 'Literal': return new LiteralImpl(original.value, original.language, new NamedNodeImpl(original.datatype.value), original.direction ?? '');
            case 'Variable': return factory.variable!(original.value);
            case 'DefaultGraph': return DEFAULT_GRAPH;
        }
    },
    fromQuad: (original) => new QuadImpl(original.subject, original.predicate, original.object, original.graph),
} as DataFactory;

export const namedNode = factory.namedNode.bind(factory);
export const blankNode = factory.blankNode.bind(factory);
export const literal = factory.literal.bind(factory);
export const defaultGraph = factory.defaultGraph.bind(factory);
export const quad = factory.quad.bind(factory);

/** Typisierte Literal-Helfer für die häufigen Fälle. */
export const typedLiteral = {
    string: (value: string) => literal(value),
    de: (value: string) => literal(value, 'de'),
    en: (value: string) => literal(value, 'en'),
    dateTime: (isoValue: string) => literal(isoValue, namedNode(XSD.dateTime)),
    integer: (value: number) => literal(String(value), namedNode(XSD.integer)),
    decimal: (value: number) => literal(String(value), namedNode(XSD.decimal)),
    boolean: (value: boolean) => literal(value ? 'true' : 'false', namedNode(XSD.boolean)),
    anyUri: (value: string) => literal(value, namedNode(XSD.anyURI)),
    /** ISO-8601-Dauer, z. B. PT5M. */
    duration: (value: string) => literal(value, namedNode(XSD.duration)),
} as const;

export { termEquals };
