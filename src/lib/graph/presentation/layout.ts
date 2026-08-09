/**
 * Präsentationsschicht `graph/<u>/presentation` (SPEC §9, M5).
 *
 * Layout — Position, Größe, Farbe, Gruppierung, Viewport — liegt
 * ausschließlich hier und referenziert semantische Knoten über
 * ow:rendersNode. Der semantische Graph enthält zu keinem Zeitpunkt
 * Layout-Werte (Invariante 2; Blacklist-Test in tests/graph/migrate.test.ts).
 *
 * Eigentums-Modell: Jedes Layout-Element trägt `schema:isPartOf <canvas>`;
 * die Layout-Gruppe eines Canvas besteht aus dem Canvas-Subjekt selbst
 * (Viewport) plus allen Elementen mit isPartOf darauf. Ersetzt wird immer
 * GRUPPENWEISE — nie der ganze Presentation-Graph, denn er trägt die
 * Layouts mehrerer Quellen (native Pinnwände UND Connector-Importe).
 *
 * Verwaiste Gruppen (Canvas existiert in keinem semantischen Graphen
 * mehr) räumt pruneOrphanCanvasLayouts auf — das deckt gelöschte native
 * Canvases ebenso wie gelöschte Connectors ab.
 */

import type { Quad } from '@rdfjs/types';
import type { GraphStore } from '../store/types';
import type { IriFactory } from '../iri';
import type { CanvasData } from '@/lib/storage/canvas';
import { factory, namedNode, literal, typedLiteral } from '../rdf';
import { DCTERMS, OW, RDF, SCHEMA } from '../vocab';

export interface CanvasLayoutGroup {
    /** IRI des ow:Canvas-Knotens, dem dieses Layout gehört. */
    canvasIri: string;
    /** Layout-Quads (ohne Graph-Komponente — load() erzwingt presentation). */
    quads: Quad[];
}

/** Darstellungsart eines nativen Kartentyps nach JSON Canvas 1.0. */
export function nodeKindForCardType(type: CanvasData['cards'][number]['type']): 'text' | 'file' | 'link' | 'group' {
    if (type === 'group') return 'group';
    if (type === 'link') return 'link';
    if (type === 'file' || type === 'image') return 'file';
    return 'text';
}

/**
 * Layout-Gruppe einer nativen Pinnwand: Viewport am Canvas-Subjekt,
 * je Karte ein ow:CanvasNode, je Verbindung ein ow:CanvasEdge.
 * Werte bleiben unverändert (keine Rundung — die passiert erst beim
 * Export in die Integer-Welt von JSON Canvas 1.0).
 */
export function buildNativeCanvasLayout(canvas: CanvasData, iri: IriFactory): CanvasLayoutGroup {
    const canvasIri = iri.entity('canvas', canvas.id);
    const quads: Quad[] = [];
    const add = (subject: string, predicate: string, object: Quad['object']) => {
        quads.push(factory.quad(namedNode(subject), namedNode(predicate), object));
    };
    const addIri = (subject: string, predicate: string, objectIri: string) =>
        add(subject, predicate, namedNode(objectIri));

    add(canvasIri, OW.viewportX, typedLiteral.decimal(canvas.viewport.x));
    add(canvasIri, OW.viewportY, typedLiteral.decimal(canvas.viewport.y));
    add(canvasIri, OW.viewportZoom, typedLiteral.decimal(canvas.viewport.zoom));

    const layoutNodeIri = (cardId: string) => iri.entity('canvas-node', `${canvas.id}/${cardId}`);
    for (const card of canvas.cards) {
        const subject = layoutNodeIri(card.id);
        addIri(subject, RDF.type, OW.CanvasNode);
        addIri(subject, SCHEMA.isPartOf, canvasIri);
        add(subject, DCTERMS.identifier, literal(card.id));
        add(subject, OW.nodeKind, literal(nodeKindForCardType(card.type)));
        add(subject, OW.xPosition, typedLiteral.decimal(card.x));
        add(subject, OW.yPosition, typedLiteral.decimal(card.y));
        add(subject, SCHEMA.width, typedLiteral.decimal(card.width));
        add(subject, SCHEMA.height, typedLiteral.decimal(card.height));
        if (card.color !== undefined && card.color !== '') {
            add(subject, SCHEMA.color, literal(card.color));
        }
        if (card.type === 'group') {
            // Gruppen sind reine Darstellung (SPEC §9) — Label am Layout-Knoten.
            if (card.title !== '') add(subject, SCHEMA.name, literal(card.title));
        } else {
            addIri(subject, OW.rendersNode, iri.entity('card', `${canvas.id}/${card.id}`));
            if ((card.type === 'file' || card.type === 'image') && card.content) {
                add(subject, OW.filePath, literal(card.content));
            }
        }
    }

    for (const connection of canvas.connections) {
        const subject = iri.entity('canvas-edge', `${canvas.id}/${connection.id}`);
        addIri(subject, RDF.type, OW.CanvasEdge);
        addIri(subject, SCHEMA.isPartOf, canvasIri);
        add(subject, DCTERMS.identifier, literal(connection.id));
        addIri(subject, OW.edgeFrom, layoutNodeIri(connection.fromId));
        addIri(subject, OW.edgeTo, layoutNodeIri(connection.toId));
        // Pfeilenden nach JSON Canvas 1.0; 'directional' entspricht den
        // Spec-Defaults und materialisiert nichts (Round-Trip-Treue).
        if (connection.type === 'bidirectional') add(subject, OW.fromEnd, literal('arrow'));
        if (connection.type === 'simple') add(subject, OW.toEnd, literal('none'));
        if (connection.label !== undefined && connection.label !== '') {
            add(subject, SCHEMA.name, literal(connection.label));
        }
    }

    return { canvasIri, quads };
}

async function dumpGraph(store: GraphStore, graphIri: string): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const q of store.dump(namedNode(graphIri))) {
        quads.push(q);
    }
    return quads;
}

/** Subjekte einer Layout-Gruppe im Bestand: Canvas-Subjekt + isPartOf-Elemente. */
function ownedSubjects(existing: Quad[], canvasIris: ReadonlySet<string>): Set<string> {
    const owned = new Set<string>(canvasIris);
    for (const q of existing) {
        if (
            q.predicate.value === SCHEMA.isPartOf &&
            q.object.termType === 'NamedNode' &&
            canvasIris.has(q.object.value) &&
            q.subject.termType === 'NamedNode'
        ) {
            owned.add(q.subject.value);
        }
    }
    return owned;
}

/**
 * Ersetzt die Layout-Gruppen der genannten Canvases im Presentation-
 * Graphen, ohne fremde Gruppen anzufassen. Läuft auf dem übergebenen
 * Store — innerhalb einer Transaktion ist das die tx-Sicht.
 */
export async function replaceCanvasLayouts(
    store: GraphStore,
    iri: IriFactory,
    groups: CanvasLayoutGroup[],
): Promise<void> {
    const graphIri = iri.graph('presentation');
    const existing = await dumpGraph(store, graphIri);
    const owned = ownedSubjects(existing, new Set(groups.map(group => group.canvasIri)));
    const remaining = existing.filter(q => !(q.subject.termType === 'NamedNode' && owned.has(q.subject.value)));
    const next = [...remaining, ...groups.flatMap(group => group.quads)];
    await store.load(next, namedNode(graphIri), { replace: true });
}

/**
 * Entfernt Layout-Gruppen, deren Canvas in keinem semantischen Graphen
 * mehr als ow:Canvas existiert (gelöschte Pinnwand, gelöschter
 * Connector). Liefert die entfernten Canvas-IRIs.
 */
export async function pruneOrphanCanvasLayouts(store: GraphStore, iri: IriFactory): Promise<string[]> {
    const graphIri = iri.graph('presentation');
    const existing = await dumpGraph(store, graphIri);
    if (existing.length === 0) return [];

    // Wurzeln: Ziele von isPartOf plus Subjekte ohne eigenes isPartOf.
    const roots = new Set<string>();
    const partOf = new Map<string, string>();
    for (const q of existing) {
        if (q.predicate.value === SCHEMA.isPartOf && q.subject.termType === 'NamedNode' && q.object.termType === 'NamedNode') {
            partOf.set(q.subject.value, q.object.value);
            roots.add(q.object.value);
        }
    }
    for (const q of existing) {
        if (q.subject.termType === 'NamedNode' && !partOf.has(q.subject.value) && !roots.has(q.subject.value)) {
            roots.add(q.subject.value);
        }
    }

    // Lebendig = irgendwo außerhalb des Presentation-Graphen als ow:Canvas typisiert.
    const alive = new Set<string>();
    for await (const q of store.dump()) {
        if (
            q.predicate.value === RDF.type &&
            q.object.termType === 'NamedNode' &&
            q.object.value === OW.Canvas &&
            q.subject.termType === 'NamedNode' &&
            !(q.graph.termType === 'NamedNode' && q.graph.value === graphIri)
        ) {
            alive.add(q.subject.value);
        }
    }

    const dead = new Set<string>([...roots].filter(root => !alive.has(root)));
    if (dead.size === 0) return [];
    const remaining = existing.filter(q => {
        if (q.subject.termType !== 'NamedNode') return true;
        if (dead.has(q.subject.value)) return false;
        const parent = partOf.get(q.subject.value);
        return !(parent !== undefined && dead.has(parent));
    });
    await store.load(remaining, namedNode(graphIri), { replace: true });
    return [...dead].sort();
}
