/**
 * Canvas — Fassade über den Store-first-Schreibpfad (Abschluss
 * SPEC §12.4): Wahrheit ist der RDF-Store (Wissen in
 * `graph/<u>/workspace`, Layout in `graph/<u>/presentation`), die
 * JSON-Dateien unter `data/canvas/` sind Projektion.
 */

import { getWorkspaceContext } from '@/lib/graph/server/instance';
import * as crud from '@/lib/graph/workspace/crud';

export interface CanvasCard {
    id: string;
    /**
     * `file` und `group` kommen mit dem JSON-Canvas-Import (M5):
     * `file` referenziert eine Datei (Pfad in `content`, optional mit
     * `#Unterabschnitt`), `group` ist ein reiner Darstellungs-Rahmen
     * (Label in `title`) ohne semantisches Gegenstück im Graphen.
     */
    type: 'note' | 'task' | 'link' | 'image' | 'file' | 'group';
    title: string;
    content?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    color?: string;
    createdAt: string;
    updatedAt: string;
}

export interface CanvasConnection {
    id: string;
    fromId: string;
    toId: string;
    type: 'simple' | 'directional' | 'bidirectional';
    label?: string;
}

export interface CanvasData {
    id: string;
    name: string;
    description?: string;
    cards: CanvasCard[];
    connections: CanvasConnection[];
    viewport: { x: number; y: number; zoom: number };
    createdAt: string;
    updatedAt: string;
}

export interface CanvasIndex {
    canvases: Array<{
        id: string;
        name: string;
        description?: string;
        cardCount: number;
        createdAt: string;
        updatedAt: string;
    }>;
}

export interface ImportCanvasInput {
    name: string;
    description?: string;
    cards: Array<Omit<CanvasCard, 'createdAt' | 'updatedAt'>>;
    connections: CanvasConnection[];
}

// Canvas CRUD
export async function listCanvases(): Promise<CanvasIndex['canvases']> {
    return crud.listCanvases(await getWorkspaceContext());
}

export async function getCanvas(id: string): Promise<CanvasData | null> {
    return crud.getCanvas(await getWorkspaceContext(), id);
}

export async function createCanvas(name: string, description?: string): Promise<CanvasData> {
    return crud.createCanvas(await getWorkspaceContext(), name, description);
}

/**
 * Legt eine Pinnwand aus einem Import (JSON Canvas 1.0, M5) an — Karten
 * und Verbindungen kommen komplett aus der Quelle, die IDs bleiben
 * erhalten (sie sind innerhalb der Datei eindeutig und tragen den
 * Round-Trip).
 */
export async function importCanvas(input: ImportCanvasInput): Promise<CanvasData> {
    return crud.importCanvas(await getWorkspaceContext(), input);
}

export async function updateCanvasMeta(id: string, updates: { name?: string; description?: string }): Promise<CanvasData | null> {
    return crud.updateCanvasMeta(await getWorkspaceContext(), id, updates);
}

export async function deleteCanvas(id: string): Promise<boolean> {
    return crud.deleteCanvas(await getWorkspaceContext(), id);
}

// Card operations
export async function createCard(canvasId: string, input: {
    type?: CanvasCard['type'];
    title: string;
    content?: string;
    x: number;
    y: number;
    width?: number;
    height?: number;
    color?: string;
}): Promise<CanvasCard | null> {
    return crud.createCard(await getWorkspaceContext(), canvasId, input);
}

export async function updateCard(canvasId: string, cardId: string, updates: Partial<Omit<CanvasCard, 'id' | 'createdAt'>>): Promise<CanvasCard | null> {
    return crud.updateCard(await getWorkspaceContext(), canvasId, cardId, updates);
}

export async function deleteCard(canvasId: string, cardId: string): Promise<boolean> {
    return crud.deleteCard(await getWorkspaceContext(), canvasId, cardId);
}

// Connection operations
export async function createConnection(
    canvasId: string,
    fromId: string,
    toId: string,
    type: CanvasConnection['type'] = 'directional',
    label?: string
): Promise<CanvasConnection | null> {
    return crud.createConnection(await getWorkspaceContext(), canvasId, fromId, toId, type, label);
}

export async function updateConnection(canvasId: string, connectionId: string, updates: Partial<Omit<CanvasConnection, 'id'>>): Promise<CanvasConnection | null> {
    return crud.updateConnection(await getWorkspaceContext(), canvasId, connectionId, updates);
}

export async function deleteConnection(canvasId: string, connectionId: string): Promise<boolean> {
    return crud.deleteConnection(await getWorkspaceContext(), canvasId, connectionId);
}

export async function updateViewport(canvasId: string, viewport: CanvasData['viewport']): Promise<void> {
    return crud.updateViewport(await getWorkspaceContext(), canvasId, viewport);
}
