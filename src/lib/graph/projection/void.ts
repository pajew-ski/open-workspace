/**
 * VoID-Selbstbeschreibung des öffentlichen Teilgraphen (SPEC §17.5, M13).
 *
 * „Öffentliche Graphen bekommen eine `void:Dataset`-Beschreibung unter
 * `/.well-known/void`, damit fremde Clients Umfang und Vokabular
 * erkennen, ohne den ganzen Graphen zu ziehen."
 *
 * Beschrieben wird **genau das, was der Anfragende sehen darf** — die
 * Funktion bekommt die Graph-Menge aus dem Grant und geht keinen zweiten
 * Weg an den Rechten vorbei. Für einen anonymen Client sind das die
 * `graph/u/<id>/public`-Graphen; ein angemeldeter Nutzer sieht die
 * Beschreibung seines eigenen Umfangs.
 */

import type { Quad } from '@rdfjs/types';
import type { GraphStore } from '../store/types';
import { describeGraph, type IriFactory } from '../iri';
import { factory, literal, namedNode, typedLiteral } from '../rdf';
import { DCTERMS, OW_VOCAB_BASE, PREFIXES, RDF, SCHEMA, VOID } from '../vocab';

export interface VoidPartition {
    /** Graph-IRI (zugleich IRI des Teil-Datasets). */
    graph: string;
    /** Nutzer, dem der Graph gehört (leer für instanzweite Graphen). */
    userId?: string;
    triples: number;
    entities: number;
    classes: string[];
    properties: string[];
    uriSpace?: string;
}

export interface VoidDescription {
    /** IRI des Gesamt-Datasets (die Installation). */
    iri: string;
    triples: number;
    partitions: VoidPartition[];
    vocabularies: string[];
}

/** Bekannte Vokabular-Basen für `void:vocabulary` (Prefix-Tabelle + ow:). */
const VOCABULARY_BASES = [OW_VOCAB_BASE, ...Object.values(PREFIXES)];

function vocabularyOf(iri: string): string | null {
    return VOCABULARY_BASES.find(base => iri.startsWith(base)) ?? null;
}

/**
 * Zählt Tripel, Entitäten, Klassen und Properties je Graph. Bewusst über
 * `dump` statt SPARQL: dieselbe Zählung läuft damit auch gegen das
 * In-Memory-Double der Tests.
 */
export async function buildVoidDescription(
    store: GraphStore,
    iri: IriFactory,
    graphs: readonly string[],
): Promise<VoidDescription> {
    const partitions: VoidPartition[] = [];
    const vocabularies = new Set<string>();
    let total = 0;

    for (const graph of [...graphs].sort()) {
        const described = describeGraph(iri.instanceBase, graph);
        const subjects = new Set<string>();
        const classes = new Set<string>();
        const properties = new Set<string>();
        let triples = 0;
        for await (const quad of store.dump(namedNode(graph))) {
            triples += 1;
            if (quad.subject.termType === 'NamedNode') subjects.add(quad.subject.value);
            properties.add(quad.predicate.value);
            if (quad.predicate.value === RDF.type && quad.object.termType === 'NamedNode') {
                classes.add(quad.object.value);
            }
            for (const value of [quad.predicate.value, quad.object.value]) {
                const vocabulary = vocabularyOf(value);
                if (vocabulary) vocabularies.add(vocabulary);
            }
        }
        total += triples;
        partitions.push({
            graph,
            ...(described?.kind === 'user' ? { userId: described.userId } : {}),
            triples,
            entities: subjects.size,
            classes: [...classes].sort(),
            properties: [...properties].sort(),
            ...(described?.kind === 'user'
                ? { uriSpace: `${iri.instanceBase}u/${encodeURIComponent(described.userId)}/` }
                : {}),
        });
    }

    return {
        iri: `${iri.instanceBase}dataset`,
        triples: total,
        partitions,
        vocabularies: [...vocabularies].sort(),
    };
}

/** VoID-Beschreibung als RDF (Turtle/JSON-LD über `serializeRdf`). */
export function voidQuads(description: VoidDescription, sparqlEndpoint?: string): Quad[] {
    const graph = namedNode(`${description.iri}#void`);
    const root = namedNode(description.iri);
    const quads: Quad[] = [
        factory.quad(root, namedNode(RDF.type), namedNode(VOID.Dataset), graph),
        factory.quad(root, namedNode(SCHEMA.name), literal('Open Workspace — öffentlicher Teilgraph', 'de'), graph),
        factory.quad(root, namedNode(VOID.triples), typedLiteral.integer(description.triples), graph),
        factory.quad(root, namedNode(DCTERMS.modified), typedLiteral.dateTime(new Date().toISOString()), graph),
    ];
    if (sparqlEndpoint) {
        quads.push(factory.quad(root, namedNode(VOID.sparqlEndpoint), namedNode(sparqlEndpoint), graph));
    }
    for (const vocabulary of description.vocabularies) {
        quads.push(factory.quad(root, namedNode(VOID.vocabulary), namedNode(vocabulary), graph));
    }
    for (const partition of description.partitions) {
        const subset = namedNode(partition.graph);
        quads.push(
            factory.quad(root, namedNode(SCHEMA.hasPart), subset, graph),
            factory.quad(subset, namedNode(RDF.type), namedNode(VOID.Dataset), graph),
            factory.quad(subset, namedNode(VOID.triples), typedLiteral.integer(partition.triples), graph),
            factory.quad(subset, namedNode(VOID.entities), typedLiteral.integer(partition.entities), graph),
        );
        if (partition.uriSpace) {
            quads.push(factory.quad(subset, namedNode(VOID.uriSpace), literal(partition.uriSpace), graph));
        }
        for (const cls of partition.classes) {
            quads.push(factory.quad(subset, namedNode(VOID.class), namedNode(cls), graph));
        }
        for (const property of partition.properties) {
            quads.push(factory.quad(subset, namedNode(VOID.properties), namedNode(property), graph));
        }
    }
    return quads;
}
