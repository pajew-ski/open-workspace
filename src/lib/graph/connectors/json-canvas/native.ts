/**
 * Abbildung native Pinnwand (CanvasData aus `src/lib/storage/canvas.ts`)
 * ↔ JSON Canvas 1.0 — der UI-Pfad der M5-Abnahme: ein in Obsidian
 * erstelltes `.canvas` öffnet im Workspace und umgekehrt.
 *
 * Pures Modul mit strukturellen Typen (kein storage-Import), damit der
 * Export auch clientseitig läuft. Verlustpositionen sind in
 * docs/obsidian-kompatibilitaet.md dokumentiert; die wichtigsten:
 * Viewport und Kanten-Anker (fromSide/toSide) überleben den nativen
 * Round-Trip nicht (der json-canvas-CONNECTOR erhält sie im Graphen),
 * Karten-Titel werden zur Markdown-Überschrift.
 */

import type {
    JsonCanvas,
    JsonCanvasEdge,
    JsonCanvasNode,
} from './format';

/** Strukturell kompatibel zu CanvasCard/CanvasConnection/CanvasData. */
export interface NativeCardLike {
    id: string;
    type: 'note' | 'task' | 'link' | 'image' | 'file' | 'group';
    title: string;
    content?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    color?: string;
}

export interface NativeConnectionLike {
    id: string;
    fromId: string;
    toId: string;
    type: 'simple' | 'directional' | 'bidirectional';
    label?: string;
}

export interface NativeCanvasLike {
    cards: NativeCardLike[];
    connections: NativeConnectionLike[];
}

/** `# Titel` als erste Zeile, danach Leerzeile + Inhalt (oder nichts). */
const TITLE_HEADING = /^# (.+)(?:\n\n([\s\S]*))?$/;

/** Karte → Markdown eines Text-Knotens (Titel wird `# `-Überschrift). */
export function cardToMarkdown(card: Pick<NativeCardLike, 'title' | 'content'>): string {
    const content = card.content ?? '';
    if (card.title === '') return content;
    return content === '' ? `# ${card.title}` : `# ${card.title}\n\n${content}`;
}

/** Markdown eines Text-Knotens → Titel + Inhalt (Umkehrung von cardToMarkdown). */
export function markdownToCard(text: string): { title: string; content: string } {
    const match = text.match(TITLE_HEADING);
    if (match && !match[1].includes('\n')) {
        return { title: match[1], content: match[2] ?? '' };
    }
    return { title: '', content: text };
}

/**
 * Pinnwand → JSON Canvas 1.0. Verlustbehaftet (SPEC §9): Kantentypen
 * flachen auf Pfeilenden ab, der Viewport entfällt, Positionen werden
 * auf ganze Zahlen gerundet (die Spec verlangt Integer).
 */
export function nativeCanvasToJsonCanvas(canvas: NativeCanvasLike): JsonCanvas {
    const nodes: JsonCanvasNode[] = [];
    for (const card of canvas.cards) {
        const base = {
            id: card.id,
            x: Math.round(card.x),
            y: Math.round(card.y),
            width: Math.round(card.width),
            height: Math.round(card.height),
            ...(card.color !== undefined && card.color !== '' ? { color: card.color } : {}),
        };
        const content = (card.content ?? '').trim();
        if (card.type === 'group') {
            nodes.push({ ...base, type: 'group', ...(card.title !== '' ? { label: card.title } : {}) });
        } else if (card.type === 'link' && content !== '') {
            nodes.push({ ...base, type: 'link', url: content });
        } else if ((card.type === 'file' || card.type === 'image') && content !== '') {
            const hash = content.indexOf('#');
            nodes.push({
                ...base,
                type: 'file',
                file: hash === -1 ? content : content.slice(0, hash),
                ...(hash !== -1 ? { subpath: content.slice(hash) } : {}),
            });
        } else {
            // note/task — und link/file/image ohne Ziel — werden Text-Knoten.
            nodes.push({ ...base, type: 'text', text: cardToMarkdown(card) });
        }
    }

    const edges: JsonCanvasEdge[] = canvas.connections.map(connection => ({
        id: connection.id,
        fromNode: connection.fromId,
        toNode: connection.toId,
        // directional entspricht den Spec-Defaults (fromEnd none, toEnd arrow).
        ...(connection.type === 'bidirectional' ? { fromEnd: 'arrow' as const } : {}),
        ...(connection.type === 'simple' ? { toEnd: 'none' as const } : {}),
        ...(connection.label !== undefined && connection.label !== '' ? { label: connection.label } : {}),
    }));

    return { nodes, edges };
}

export interface JsonCanvasToNativeResult {
    cards: NativeCardLike[];
    connections: NativeConnectionLike[];
}

function lastSegment(path: string): string {
    const clean = path.replace(/\\/g, '/');
    const segment = clean.slice(clean.lastIndexOf('/') + 1);
    return segment === '' ? clean : segment;
}

/**
 * JSON Canvas 1.0 → Pinnwand-Karten/-Verbindungen. Kanten-Anker
 * (fromSide/toSide) und Kanten-Farben kennt das native Modell nicht —
 * dokumentierte Verlustposition des UI-Pfads. Eine Kante mit Pfeil nur
 * am Start wird als gedrehte gerichtete Verbindung übernommen, damit
 * die sichtbare Pfeilspitze erhalten bleibt.
 */
export function jsonCanvasToNative(canvas: JsonCanvas): JsonCanvasToNativeResult {
    const cards: NativeCardLike[] = canvas.nodes.map(node => {
        const base = {
            id: node.id,
            x: node.x,
            y: node.y,
            width: node.width,
            height: node.height,
            ...(node.color !== undefined ? { color: node.color } : {}),
        };
        switch (node.type) {
            case 'text': {
                const { title, content } = markdownToCard(node.text);
                return { ...base, type: 'note', title, content };
            }
            case 'file': {
                const target = `${node.file}${node.subpath ?? ''}`;
                return { ...base, type: 'file', title: lastSegment(node.file), content: target };
            }
            case 'link':
                return { ...base, type: 'link', title: node.url, content: node.url };
            case 'group':
                return { ...base, type: 'group', title: node.label ?? '' };
        }
    });

    const connections: NativeConnectionLike[] = canvas.edges.map(edge => {
        const fromArrow = edge.fromEnd === 'arrow';
        const toArrow = edge.toEnd !== 'none';
        let type: NativeConnectionLike['type'];
        let fromId = edge.fromNode;
        let toId = edge.toNode;
        if (fromArrow && toArrow) {
            type = 'bidirectional';
        } else if (fromArrow) {
            type = 'directional';
            [fromId, toId] = [toId, fromId];
        } else if (toArrow) {
            type = 'directional';
        } else {
            type = 'simple';
        }
        return {
            id: edge.id,
            fromId,
            toId,
            type,
            ...(edge.label !== undefined ? { label: edge.label } : {}),
        };
    });

    return { cards, connections };
}
