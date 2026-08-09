/**
 * Abbildung JSON Canvas 1.0 → RDF (SPEC §9, Import-Richtung des
 * `json-canvas`-Connectors).
 *
 * Zwei strikt getrennte Schichten:
 *
 *  1. WISSEN (Import-Graph): der Canvas als ow:Canvas-Knoten, je
 *     text/file/link-Knoten ein semantisches Gegenstück (schema:hasPart),
 *     Kanten als untypisierte ow:linksTo-Tripel — „sofern kein Typ
 *     ableitbar ist" (SPEC §9); JSON Canvas kennt keine Kantentypen.
 *     Gruppen bekommen KEIN semantisches Gegenstück: sie sind implizit
 *     über Position definiert, keine Hierarchie-Behauptung (SPEC §9).
 *  2. LAYOUT (Presentation-Graph): je Knoten ein ow:CanvasNode, je Kante
 *     ein ow:CanvasEdge mit allen JSON-Canvas-1.0-Attributen — nur
 *     explizit gesetzte Werte werden materialisiert (Round-Trip-Treue).
 */

import type { Quad } from '@rdfjs/types';
import type { IriFactory } from '../../iri';
import { factory, namedNode, literal, typedLiteral } from '../../rdf';
import { DCTERMS, OW, RDF, SCHEMA } from '../../vocab';
import type { JsonCanvas, JsonCanvasNode } from './format';

export interface JsonCanvasQuadsResult {
    /** Wissens-Schicht — Ziel: graph/<u>/import/<id> (lädt der Runner). */
    semantic: Quad[];
    /** Layout-Schicht — Ziel: graph/<u>/presentation (meldet ctx.presentation). */
    layout: Quad[];
    /** IRI des ow:Canvas-Knotens (Wurzel der Layout-Gruppe). */
    canvasIri: string;
    nodes: number;
    edges: number;
}

/** Anzeigename: Dateiname ohne `.canvas`-Endung. */
export function canvasNameFromLocator(locator: string): string {
    const clean = locator.replace(/\\/g, '/');
    const basename = clean.slice(clean.lastIndexOf('/') + 1);
    return basename.replace(/\.canvas$/i, '') || basename;
}

function semanticCounterpart(
    node: JsonCanvasNode,
    subject: string,
    add: (s: string, p: string, o: Quad['object']) => void,
    addIri: (s: string, p: string, o: string) => void,
): void {
    switch (node.type) {
        case 'text':
            addIri(subject, RDF.type, SCHEMA.CreativeWork);
            add(subject, SCHEMA.text, literal(node.text));
            break;
        case 'file':
            // Referenz auf ein andernorts liegendes Dokument — Inhalt und
            // Auflösung gehören dem Vault (bzw. dessen Connector), nicht
            // dieser Canvas-Quelle.
            addIri(subject, RDF.type, SCHEMA.DigitalDocument);
            add(subject, SCHEMA.name, literal(node.file));
            break;
        case 'link':
            addIri(subject, RDF.type, SCHEMA.WebPage);
            add(subject, SCHEMA.url, typedLiteral.anyUri(node.url));
            break;
        case 'group':
            // Kein semantisches Gegenstück (SPEC §9).
            break;
    }
}

/**
 * Baut Wissens- und Layout-Quads eines geparsten `.canvas`-Standes.
 * `key` ist die Connector-Instanz-ID (stabiler IRI-Namensraum).
 * Die Rückgaben tragen keine Graph-Komponente — die Ziel-Graphen
 * erzwingen Runner bzw. Presentation-Replace (Invariante 4).
 */
export function buildJsonCanvasQuads(
    canvas: JsonCanvas,
    iri: IriFactory,
    key: string,
    locator: string,
): JsonCanvasQuadsResult {
    const semantic: Quad[] = [];
    const layout: Quad[] = [];
    const push = (target: Quad[]) => ({
        add: (subject: string, predicate: string, object: Quad['object']) => {
            target.push(factory.quad(namedNode(subject), namedNode(predicate), object));
        },
        addIri(subject: string, predicate: string, objectIri: string) {
            this.add(subject, predicate, namedNode(objectIri));
        },
    });
    const sem = push(semantic);
    const lay = push(layout);

    const canvasIri = iri.entity('canvas', key);
    sem.addIri(canvasIri, RDF.type, OW.Canvas);
    sem.addIri(canvasIri, RDF.type, SCHEMA.CreativeWork);
    sem.add(canvasIri, SCHEMA.name, literal(canvasNameFromLocator(locator)));
    sem.add(canvasIri, DCTERMS.identifier, literal(locator));

    const counterpartIri = (nodeId: string) => iri.entity('card', `${key}/${nodeId}`);
    const layoutNodeIri = (nodeId: string) => iri.entity('canvas-node', `${key}/${nodeId}`);
    const groups = new Set<string>();

    for (const node of canvas.nodes) {
        const subject = layoutNodeIri(node.id);
        lay.addIri(subject, RDF.type, OW.CanvasNode);
        lay.addIri(subject, SCHEMA.isPartOf, canvasIri);
        lay.add(subject, DCTERMS.identifier, literal(node.id));
        lay.add(subject, OW.nodeKind, literal(node.type));
        lay.add(subject, OW.xPosition, typedLiteral.decimal(node.x));
        lay.add(subject, OW.yPosition, typedLiteral.decimal(node.y));
        lay.add(subject, SCHEMA.width, typedLiteral.decimal(node.width));
        lay.add(subject, SCHEMA.height, typedLiteral.decimal(node.height));
        if (node.color !== undefined) lay.add(subject, SCHEMA.color, literal(node.color));

        if (node.type === 'group') {
            groups.add(node.id);
            if (node.label !== undefined) lay.add(subject, SCHEMA.name, literal(node.label));
            if (node.background !== undefined) lay.add(subject, OW.background, literal(node.background));
            if (node.backgroundStyle !== undefined) lay.add(subject, OW.backgroundStyle, literal(node.backgroundStyle));
            continue;
        }

        if (node.type === 'file') {
            lay.add(subject, OW.filePath, literal(`${node.file}${node.subpath ?? ''}`));
        }
        const counterpart = counterpartIri(node.id);
        lay.addIri(subject, OW.rendersNode, counterpart);
        sem.addIri(canvasIri, SCHEMA.hasPart, counterpart);
        sem.add(counterpart, DCTERMS.identifier, literal(node.id));
        semanticCounterpart(node, counterpart, sem.add.bind(sem), sem.addIri.bind(sem));
    }

    for (const edge of canvas.edges) {
        const subject = iri.entity('canvas-edge', `${key}/${edge.id}`);
        lay.addIri(subject, RDF.type, OW.CanvasEdge);
        lay.addIri(subject, SCHEMA.isPartOf, canvasIri);
        lay.add(subject, DCTERMS.identifier, literal(edge.id));
        lay.addIri(subject, OW.edgeFrom, layoutNodeIri(edge.fromNode));
        lay.addIri(subject, OW.edgeTo, layoutNodeIri(edge.toNode));
        if (edge.fromSide !== undefined) lay.add(subject, OW.fromSide, literal(edge.fromSide));
        if (edge.fromEnd !== undefined) lay.add(subject, OW.fromEnd, literal(edge.fromEnd));
        if (edge.toSide !== undefined) lay.add(subject, OW.toSide, literal(edge.toSide));
        if (edge.toEnd !== undefined) lay.add(subject, OW.toEnd, literal(edge.toEnd));
        if (edge.color !== undefined) lay.add(subject, SCHEMA.color, literal(edge.color));
        if (edge.label !== undefined) lay.add(subject, SCHEMA.name, literal(edge.label));

        // Wissens-Behauptung nur zwischen semantischen Gegenstücken —
        // Kanten an Gruppen sind reine Zeichnung.
        if (!groups.has(edge.fromNode) && !groups.has(edge.toNode)) {
            sem.addIri(counterpartIri(edge.fromNode), OW.linksTo, counterpartIri(edge.toNode));
        }
    }

    return { semantic, layout, canvasIri, nodes: canvas.nodes.length, edges: canvas.edges.length };
}
