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
import type { Project } from '@/lib/storage/projects';
import type { CalendarProvider } from '@/lib/storage/calendar';
import type { Conversation } from '@/lib/storage/chat';
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
        // Nativer Kartentyp, wo er feiner ist als der JSON-Canvas-nodeKind
        // ('task' ↔ text, 'image' ↔ file) — Quelltreue-Träger für den
        // Round-Trip Store → Pinnwand (Abschluss SPEC §12.4).
        if (card.type === 'task' || card.type === 'image') {
            add(subject, OW.cardKind, literal(card.type));
        }
        if (card.type === 'group') {
            // Gruppen sind reine Darstellung (SPEC §9) — Label und
            // Zeitstempel am Layout-Knoten, denn ein semantisches
            // Gegenstück existiert nicht.
            if (card.title !== '') add(subject, SCHEMA.name, literal(card.title));
            add(subject, DCTERMS.created, typedLiteral.dateTime(card.createdAt));
            add(subject, DCTERMS.modified, typedLiteral.dateTime(card.updatedAt));
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

/**
 * Darstellungswerte, die an einer Entität selbst hängen statt an einer
 * Canvas-Layout-Gruppe (Abschluss SPEC §12.4, erweitert in M15):
 *
 *  - Projekt-Farbe   `<projekt> schema:color "#…"`
 *  - Kalender-Farbe  `<kalender> schema:color "#…"`
 *  - Chat-Auswahl    `<unterhaltung> ow:selected true`
 *  - A2UI-Oberfläche `<nachricht> ow:generativeSurface "<json>"`
 *
 * Alles davon ist Darstellung, kein Wissen (Invariante 2) — und keines
 * davon trägt `schema:isPartOf`, damit `pruneOrphanCanvasLayouts` diese
 * Subjekte nicht für Layout-Gruppen einer gelöschten Pinnwand hält.
 * Ersetzt werden alle Subjekte der genannten Entitätsarten vollständig,
 * ohne Canvas-Layout-Gruppen anzufassen; läuft auf dem übergebenen Store
 * — innerhalb einer Transaktion ist das die tx-Sicht.
 */
export async function replaceEntityPresentation(
    store: GraphStore,
    iri: IriFactory,
    input: {
        projects: ReadonlyArray<Project>;
        calendars: ReadonlyArray<CalendarProvider>;
        conversations: ReadonlyArray<Conversation>;
        activeConversationId?: string | null;
    },
): Promise<void> {
    const graphIri = iri.graph('presentation');
    const owned = (['project', 'calendar', 'conversation', 'message'] as const)
        .map(kind => `${iri.instanceBase}u/${encodeURIComponent(iri.userId)}/${kind}/`);
    const existing = await dumpGraph(store, graphIri);
    const next = existing.filter(q =>
        !(q.subject.termType === 'NamedNode' && owned.some(prefix => q.subject.value.startsWith(prefix))),
    );
    const add = (subject: string, predicate: string, object: Quad['object']) => {
        next.push(factory.quad(namedNode(subject), namedNode(predicate), object));
    };

    for (const project of input.projects) {
        if (project.color === '') continue;
        add(iri.entity('project', project.id), SCHEMA.color, literal(project.color));
    }
    for (const calendar of input.calendars) {
        if (calendar.color === '') continue;
        add(iri.entity('calendar', calendar.id), SCHEMA.color, literal(calendar.color));
    }
    for (const conversation of input.conversations) {
        if (conversation.id === input.activeConversationId) {
            add(iri.entity('conversation', conversation.id), OW.selected, typedLiteral.boolean(true));
        }
        for (const message of conversation.messages) {
            if (!message.uiComponents || message.uiComponents.length === 0) continue;
            add(
                iri.entity('message', `${conversation.id}/${message.id}`),
                OW.generativeSurface,
                literal(JSON.stringify(message.uiComponents)),
            );
        }
    }

    await store.load(next, namedNode(graphIri), { replace: true });
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

    // Canvas-Wurzeln: Ziele von isPartOf plus Subjekte mit Viewport-Werten
    // (leere Pinnwand). Subjekte ohne beides — z. B. Projekt-Farben — sind
    // keine Layout-Gruppen und werden hier nicht angefasst.
    const roots = new Set<string>();
    const partOf = new Map<string, string>();
    for (const q of existing) {
        if (q.predicate.value === SCHEMA.isPartOf && q.subject.termType === 'NamedNode' && q.object.termType === 'NamedNode') {
            partOf.set(q.subject.value, q.object.value);
            roots.add(q.object.value);
        }
    }
    for (const q of existing) {
        if (
            q.subject.termType === 'NamedNode' &&
            !partOf.has(q.subject.value) &&
            !roots.has(q.subject.value) &&
            (q.predicate.value === OW.viewportX || q.predicate.value === OW.viewportY || q.predicate.value === OW.viewportZoom)
        ) {
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
