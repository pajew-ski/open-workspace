/**
 * Projektion Graph → JSON Canvas 1.0 (SPEC §9, Export-Richtung).
 *
 * Umkehrung von connectors/json-canvas/map.ts: liest die Wissens-Schicht
 * (Import- bzw. Workspace-Graph) und die Layout-Schicht (Presentation-
 * Graph) eines Canvas und baut das `.canvas`-Objekt. Verlustbehaftet
 * per Spezifikation: Kantentypen kennt JSON Canvas nicht (alle Kanten
 * sind untypisierte Linien mit Pfeilenden), der Viewport entfällt.
 */

import type { Quad } from '@rdfjs/types';
import { DCTERMS, OW, SCHEMA } from '../vocab';
import type {
    JsonCanvas,
    JsonCanvasBackgroundStyle,
    JsonCanvasEdge,
    JsonCanvasEnd,
    JsonCanvasNode,
    JsonCanvasSide,
} from '../connectors/json-canvas/format';

interface SubjectIndex {
    byPredicate: Map<string, Quad[]>;
}

function indexBySubject(quads: Quad[]): Map<string, SubjectIndex> {
    const index = new Map<string, SubjectIndex>();
    for (const q of quads) {
        if (q.subject.termType !== 'NamedNode') continue;
        let entry = index.get(q.subject.value);
        if (!entry) {
            entry = { byPredicate: new Map() };
            index.set(q.subject.value, entry);
        }
        const list = entry.byPredicate.get(q.predicate.value) ?? [];
        list.push(q);
        entry.byPredicate.set(q.predicate.value, list);
    }
    return index;
}

function firstValue(entry: SubjectIndex | undefined, predicate: string): string | undefined {
    return entry?.byPredicate.get(predicate)?.[0]?.object.value;
}

function firstIri(entry: SubjectIndex | undefined, predicate: string): string | undefined {
    const term = entry?.byPredicate.get(predicate)?.[0]?.object;
    return term?.termType === 'NamedNode' ? term.value : undefined;
}

function hasType(entry: SubjectIndex | undefined, type: string): boolean {
    return (entry?.byPredicate.get('http://www.w3.org/1999/02/22-rdf-syntax-ns#type') ?? [])
        .some(q => q.object.termType === 'NamedNode' && q.object.value === type);
}

function numeric(entry: SubjectIndex | undefined, predicate: string): number {
    const value = Number(firstValue(entry, predicate));
    return Number.isFinite(value) ? value : 0;
}

/**
 * Baut das JSON-Canvas-Objekt eines Canvas aus Wissens- und Layout-Quads.
 * `layout` ist der (auf die Layout-Gruppe gefilterte oder komplette)
 * Presentation-Bestand, `semantic` der Graph mit den Gegenstücken.
 */
export function projectCanvasToJsonCanvas(
    canvasIri: string,
    semantic: Quad[],
    layout: Quad[],
): JsonCanvas {
    const layoutIndex = indexBySubject(layout);
    const semanticIndex = indexBySubject(semantic);

    const members: Array<{ iri: string; entry: SubjectIndex }> = [];
    for (const [subject, entry] of layoutIndex) {
        if (firstIri(entry, SCHEMA.isPartOf) === canvasIri) {
            members.push({ iri: subject, entry });
        }
    }

    const nodes: JsonCanvasNode[] = [];
    const nodeIdByIri = new Map<string, string>();
    for (const { iri, entry } of members) {
        if (!hasType(entry, OW.CanvasNode)) continue;
        const id = firstValue(entry, DCTERMS.identifier);
        if (id === undefined) continue;
        nodeIdByIri.set(iri, id);

        const base = {
            id,
            x: numeric(entry, OW.xPosition),
            y: numeric(entry, OW.yPosition),
            width: numeric(entry, SCHEMA.width),
            height: numeric(entry, SCHEMA.height),
            ...(firstValue(entry, SCHEMA.color) !== undefined ? { color: firstValue(entry, SCHEMA.color) } : {}),
        };
        const kind = firstValue(entry, OW.nodeKind) ?? 'text';
        const counterpart = firstIri(entry, OW.rendersNode);
        const counterpartEntry = counterpart !== undefined ? semanticIndex.get(counterpart) : undefined;

        if (kind === 'group') {
            const label = firstValue(entry, SCHEMA.name);
            const background = firstValue(entry, OW.background);
            const backgroundStyle = firstValue(entry, OW.backgroundStyle);
            nodes.push({
                ...base,
                type: 'group',
                ...(label !== undefined ? { label } : {}),
                ...(background !== undefined ? { background } : {}),
                ...(backgroundStyle !== undefined ? { backgroundStyle: backgroundStyle as JsonCanvasBackgroundStyle } : {}),
            });
        } else if (kind === 'file') {
            const target = firstValue(entry, OW.filePath) ?? firstValue(counterpartEntry, SCHEMA.name) ?? '';
            const hash = target.indexOf('#');
            nodes.push({
                ...base,
                type: 'file',
                file: hash === -1 ? target : target.slice(0, hash),
                ...(hash !== -1 ? { subpath: target.slice(hash) } : {}),
            });
        } else if (kind === 'link') {
            nodes.push({ ...base, type: 'link', url: firstValue(counterpartEntry, SCHEMA.url) ?? '' });
        } else {
            nodes.push({ ...base, type: 'text', text: firstValue(counterpartEntry, SCHEMA.text) ?? '' });
        }
    }

    const edges: JsonCanvasEdge[] = [];
    for (const { entry } of members) {
        if (!hasType(entry, OW.CanvasEdge)) continue;
        const id = firstValue(entry, DCTERMS.identifier);
        const fromIri = firstIri(entry, OW.edgeFrom);
        const toIri = firstIri(entry, OW.edgeTo);
        if (id === undefined || fromIri === undefined || toIri === undefined) continue;
        const fromNode = nodeIdByIri.get(fromIri);
        const toNode = nodeIdByIri.get(toIri);
        if (fromNode === undefined || toNode === undefined) continue;
        const fromSide = firstValue(entry, OW.fromSide);
        const fromEnd = firstValue(entry, OW.fromEnd);
        const toSide = firstValue(entry, OW.toSide);
        const toEnd = firstValue(entry, OW.toEnd);
        const color = firstValue(entry, SCHEMA.color);
        const label = firstValue(entry, SCHEMA.name);
        edges.push({
            id,
            fromNode,
            ...(fromSide !== undefined ? { fromSide: fromSide as JsonCanvasSide } : {}),
            ...(fromEnd !== undefined ? { fromEnd: fromEnd as JsonCanvasEnd } : {}),
            toNode,
            ...(toSide !== undefined ? { toSide: toSide as JsonCanvasSide } : {}),
            ...(toEnd !== undefined ? { toEnd: toEnd as JsonCanvasEnd } : {}),
            ...(color !== undefined ? { color } : {}),
            ...(label !== undefined ? { label } : {}),
        });
    }

    return { nodes, edges };
}
