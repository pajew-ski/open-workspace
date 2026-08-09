/**
 * Dokumente — Fassade über den Store-first-Schreibpfad (Abschluss
 * SPEC §12.4): Wahrheit ist der RDF-Store (`graph/<u>/workspace`), die
 * Markdown-Dateien unter `data/docs/` sind Projektion und werden von
 * `src/lib/graph/workspace/files.ts` geschrieben. Diese Fassade hält die
 * bisherige API für Routen und Module stabil.
 */

import { Doc, DocType } from '@/types/doc';
import { getWorkspaceContext } from '@/lib/graph/server/instance';
import * as crud from '@/lib/graph/workspace/crud';
import { slugifyTitle } from '@/lib/graph/migrate/from-files';

/** Englischer Slug aus dem Titel (identische Logik wie die Graph-Abbildung). */
export function generateSlug(title: string): string {
    return slugifyTitle(title);
}

export async function listDocs(): Promise<Doc[]> {
    return crud.listDocs(await getWorkspaceContext());
}

export async function getDoc(id: string): Promise<Doc | null> {
    return crud.getDoc(await getWorkspaceContext(), id);
}

export async function getDocBySlug(slug: string): Promise<Doc | null> {
    return crud.getDocBySlug(await getWorkspaceContext(), slug);
}

export async function createDoc(data: {
    title: string;
    content: string;
    category?: string;
    type?: DocType;
    tags?: string[];
}): Promise<Doc> {
    return crud.createDoc(await getWorkspaceContext(), data);
}

export async function updateDoc(id: string, data: {
    title?: string;
    content?: string;
    category?: string;
    tags?: string[];
    type?: DocType;
    slug?: string;
}): Promise<Doc | null> {
    return crud.updateDoc(await getWorkspaceContext(), id, data);
}

export async function deleteDoc(id: string): Promise<boolean> {
    return crud.deleteDoc(await getWorkspaceContext(), id);
}
