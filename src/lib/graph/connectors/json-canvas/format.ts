/**
 * JSON Canvas 1.0 (https://jsoncanvas.org, das `.canvas`-Format von
 * Obsidian) — pures Parse-/Serialisier-Modul ohne Store- oder
 * Dateisystem-Bindung, nutzbar auf Server und Client.
 *
 * Parsen ist fehlertolerant (M3-Regel: ein Import scheitert nie an der
 * Qualität der Quelle): ungültige Knoten/Kanten werden übersprungen und
 * als Issue gemeldet, der Rest wird übernommen. Nur ein komplett
 * unlesbares JSON ergibt eine leere Canvas mit Datei-Issue.
 *
 * Serialisieren ist deterministisch: Knoten und Kanten nach ID sortiert,
 * feste Schlüsselreihenfolge, Tab-Einrückung (wie Obsidian), Zeilenumbruch
 * am Ende. Export → Import → Export ist byte-identisch (Fixpunkt).
 */

export type JsonCanvasSide = 'top' | 'right' | 'bottom' | 'left';
export type JsonCanvasEnd = 'none' | 'arrow';
export type JsonCanvasBackgroundStyle = 'cover' | 'ratio' | 'repeat';
export type JsonCanvasNodeKind = 'text' | 'file' | 'link' | 'group';

interface JsonCanvasNodeBase {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    /** Hex (`#RRGGBB`) oder Preset `"1"`–`"6"`. */
    color?: string;
}

export interface JsonCanvasTextNode extends JsonCanvasNodeBase {
    type: 'text';
    /** Markdown. */
    text: string;
}

export interface JsonCanvasFileNode extends JsonCanvasNodeBase {
    type: 'file';
    /** Vault-relativer Pfad. */
    file: string;
    /** Beginnt mit `#` (Überschrift/Block innerhalb der Datei). */
    subpath?: string;
}

export interface JsonCanvasLinkNode extends JsonCanvasNodeBase {
    type: 'link';
    url: string;
}

export interface JsonCanvasGroupNode extends JsonCanvasNodeBase {
    type: 'group';
    label?: string;
    background?: string;
    backgroundStyle?: JsonCanvasBackgroundStyle;
}

export type JsonCanvasNode =
    | JsonCanvasTextNode
    | JsonCanvasFileNode
    | JsonCanvasLinkNode
    | JsonCanvasGroupNode;

export interface JsonCanvasEdge {
    id: string;
    fromNode: string;
    fromSide?: JsonCanvasSide;
    /** Default laut Spec: `none`. */
    fromEnd?: JsonCanvasEnd;
    toNode: string;
    toSide?: JsonCanvasSide;
    /** Default laut Spec: `arrow`. */
    toEnd?: JsonCanvasEnd;
    color?: string;
    label?: string;
}

export interface JsonCanvas {
    nodes: JsonCanvasNode[];
    edges: JsonCanvasEdge[];
}

export interface JsonCanvasIssue {
    /** Quell-Bezeichnung, z. B. `nodes[3]` oder `edges[0] (id "e1")`. */
    source: string;
    /** Menschlich lesbare Begründung (deutsch). */
    reason: string;
}

export interface ParsedJsonCanvas {
    canvas: JsonCanvas;
    issues: JsonCanvasIssue[];
}

const SIDES: ReadonlySet<string> = new Set(['top', 'right', 'bottom', 'left']);
const ENDS: ReadonlySet<string> = new Set(['none', 'arrow']);
const BACKGROUND_STYLES: ReadonlySet<string> = new Set(['cover', 'ratio', 'repeat']);
const NODE_KINDS: ReadonlySet<string> = new Set(['text', 'file', 'link', 'group']);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

/**
 * Parst eine `.canvas`-Datei fehlertolerant. Wirft nie: unlesbares JSON
 * ergibt eine leere Canvas plus Datei-Issue, ungültige Einträge werden
 * einzeln übersprungen und begründet.
 */
export function parseJsonCanvas(text: string, sourceName = '.canvas'): ParsedJsonCanvas {
    const issues: JsonCanvasIssue[] = [];
    const canvas: JsonCanvas = { nodes: [], edges: [] };

    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        issues.push({
            source: sourceName,
            reason: `JSON nicht lesbar: ${error instanceof Error ? error.message : String(error)}`,
        });
        return { canvas, issues };
    }
    if (!isRecord(raw)) {
        issues.push({ source: sourceName, reason: 'Wurzel ist kein JSON-Objekt (JSON Canvas 1.0 erwartet { nodes, edges }).' });
        return { canvas, issues };
    }

    const seenNodeIds = new Set<string>();
    const rawNodes = raw.nodes;
    if (rawNodes !== undefined && !Array.isArray(rawNodes)) {
        issues.push({ source: `${sourceName}#nodes`, reason: '"nodes" ist kein Array.' });
    }
    for (const [index, entry] of (Array.isArray(rawNodes) ? rawNodes : []).entries()) {
        const where = `nodes[${index}]`;
        const skip = (reason: string) => issues.push({ source: where, reason });
        if (!isRecord(entry)) { skip('Eintrag ist kein Objekt.'); continue; }
        const id = entry.id;
        if (typeof id !== 'string' || id === '') { skip('"id" fehlt oder ist kein String.'); continue; }
        if (seenNodeIds.has(id)) { skip(`Knoten-ID "${id}" ist doppelt — Eintrag übersprungen.`); continue; }
        const type = entry.type;
        if (typeof type !== 'string' || !NODE_KINDS.has(type)) {
            skip(`Unbekannter Knotentyp ${JSON.stringify(entry.type)} (erwartet: text, file, link, group).`);
            continue;
        }
        const geometry: Partial<Record<'x' | 'y' | 'width' | 'height', number>> = {};
        let geometryOk = true;
        for (const key of ['x', 'y', 'width', 'height'] as const) {
            const value = entry[key];
            if (typeof value !== 'number' || !Number.isFinite(value)) {
                skip(`"${key}" fehlt oder ist keine endliche Zahl.`);
                geometryOk = false;
                break;
            }
            geometry[key] = value;
        }
        if (!geometryOk) continue;
        const base: JsonCanvasNodeBase = {
            id,
            x: geometry.x as number,
            y: geometry.y as number,
            width: geometry.width as number,
            height: geometry.height as number,
        };
        const color = optionalString(entry.color);
        if (color !== undefined) base.color = color;

        if (type === 'text') {
            if (typeof entry.text !== 'string') { skip('Text-Knoten ohne "text"-String.'); continue; }
            canvas.nodes.push({ ...base, type, text: entry.text });
        } else if (type === 'file') {
            if (typeof entry.file !== 'string' || entry.file === '') { skip('Datei-Knoten ohne "file"-Pfad.'); continue; }
            const node: JsonCanvasFileNode = { ...base, type, file: entry.file };
            const subpath = optionalString(entry.subpath);
            if (subpath !== undefined) node.subpath = subpath;
            canvas.nodes.push(node);
        } else if (type === 'link') {
            if (typeof entry.url !== 'string' || entry.url === '') { skip('Link-Knoten ohne "url".'); continue; }
            canvas.nodes.push({ ...base, type, url: entry.url });
        } else {
            const node: JsonCanvasGroupNode = { ...base, type: 'group' };
            const label = optionalString(entry.label);
            if (label !== undefined) node.label = label;
            const background = optionalString(entry.background);
            if (background !== undefined) node.background = background;
            const backgroundStyle = optionalString(entry.backgroundStyle);
            if (backgroundStyle !== undefined) {
                if (BACKGROUND_STYLES.has(backgroundStyle)) {
                    node.backgroundStyle = backgroundStyle as JsonCanvasBackgroundStyle;
                } else {
                    issues.push({ source: where, reason: `Unbekannter backgroundStyle "${backgroundStyle}" wird ignoriert.` });
                }
            }
            canvas.nodes.push(node);
        }
        seenNodeIds.add(id);
    }

    const seenEdgeIds = new Set<string>();
    const rawEdges = raw.edges;
    if (rawEdges !== undefined && !Array.isArray(rawEdges)) {
        issues.push({ source: `${sourceName}#edges`, reason: '"edges" ist kein Array.' });
    }
    for (const [index, entry] of (Array.isArray(rawEdges) ? rawEdges : []).entries()) {
        const where = `edges[${index}]`;
        const skip = (reason: string) => issues.push({ source: where, reason });
        if (!isRecord(entry)) { skip('Eintrag ist kein Objekt.'); continue; }
        const id = entry.id;
        if (typeof id !== 'string' || id === '') { skip('"id" fehlt oder ist kein String.'); continue; }
        if (seenEdgeIds.has(id)) { skip(`Kanten-ID "${id}" ist doppelt — Eintrag übersprungen.`); continue; }
        const fromNode = entry.fromNode;
        const toNode = entry.toNode;
        if (typeof fromNode !== 'string' || typeof toNode !== 'string') {
            skip('"fromNode"/"toNode" fehlen oder sind keine Strings.');
            continue;
        }
        if (!seenNodeIds.has(fromNode) || !seenNodeIds.has(toNode)) {
            skip(`Kante "${id}" referenziert unbekannte Knoten (${fromNode} → ${toNode}).`);
            continue;
        }
        const edge: JsonCanvasEdge = { id, fromNode, toNode };
        const readEnum = <T extends string>(key: 'fromSide' | 'toSide' | 'fromEnd' | 'toEnd', allowed: ReadonlySet<string>): T | undefined => {
            const value = entry[key];
            if (value === undefined) return undefined;
            if (typeof value === 'string' && allowed.has(value)) return value as T;
            issues.push({ source: where, reason: `Ungültiger Wert für "${key}" (${JSON.stringify(value)}) wird ignoriert.` });
            return undefined;
        };
        const fromSide = readEnum<JsonCanvasSide>('fromSide', SIDES);
        if (fromSide !== undefined) edge.fromSide = fromSide;
        const fromEnd = readEnum<JsonCanvasEnd>('fromEnd', ENDS);
        if (fromEnd !== undefined) edge.fromEnd = fromEnd;
        const toSide = readEnum<JsonCanvasSide>('toSide', SIDES);
        if (toSide !== undefined) edge.toSide = toSide;
        const toEnd = readEnum<JsonCanvasEnd>('toEnd', ENDS);
        if (toEnd !== undefined) edge.toEnd = toEnd;
        const color = optionalString(entry.color);
        if (color !== undefined) edge.color = color;
        const label = optionalString(entry.label);
        if (label !== undefined) edge.label = label;
        canvas.edges.push(edge);
        seenEdgeIds.add(id);
    }

    return { canvas, issues };
}

/** Feste Schlüsselreihenfolge pro Knoten — Normalisierung des Exports. */
function orderedNode(node: JsonCanvasNode): Record<string, unknown> {
    const out: Record<string, unknown> = { id: node.id, type: node.type };
    if (node.type === 'text') out.text = node.text;
    if (node.type === 'file') {
        out.file = node.file;
        if (node.subpath !== undefined) out.subpath = node.subpath;
    }
    if (node.type === 'link') out.url = node.url;
    if (node.type === 'group') {
        if (node.label !== undefined) out.label = node.label;
        if (node.background !== undefined) out.background = node.background;
        if (node.backgroundStyle !== undefined) out.backgroundStyle = node.backgroundStyle;
    }
    out.x = node.x;
    out.y = node.y;
    out.width = node.width;
    out.height = node.height;
    if (node.color !== undefined) out.color = node.color;
    return out;
}

function orderedEdge(edge: JsonCanvasEdge): Record<string, unknown> {
    const out: Record<string, unknown> = { id: edge.id, fromNode: edge.fromNode };
    if (edge.fromSide !== undefined) out.fromSide = edge.fromSide;
    if (edge.fromEnd !== undefined) out.fromEnd = edge.fromEnd;
    out.toNode = edge.toNode;
    if (edge.toSide !== undefined) out.toSide = edge.toSide;
    if (edge.toEnd !== undefined) out.toEnd = edge.toEnd;
    if (edge.color !== undefined) out.color = edge.color;
    if (edge.label !== undefined) out.label = edge.label;
    return out;
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Serialisiert deterministisch nach JSON Canvas 1.0 (Tab-Einrückung wie
 * Obsidian, Knoten/Kanten nach ID sortiert, Zeilenumbruch am Ende).
 */
export function serializeJsonCanvas(canvas: JsonCanvas): string {
    const body = {
        nodes: [...canvas.nodes].sort(byId).map(orderedNode),
        edges: [...canvas.edges].sort(byId).map(orderedEdge),
    };
    return `${JSON.stringify(body, null, '\t')}\n`;
}
