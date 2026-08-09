/**
 * Datei-Ebene des Workspace (Abschluss SPEC §12.4).
 *
 * Zwei Rollen, beide bewusst hier statt in `src/lib/storage/*`:
 *
 *  1. **Bootstrap-Leser**: Einlesen des Alt-Bestands (`data/docs|tasks|canvas`)
 *     für die einmalige (Re-)Migration in den Store — die Dateien waren bis
 *     zum Abschluss von §12.4 die operative Quelle.
 *  2. **Projektions-Schreiber**: Nach jeder Store-Mutation werden die
 *     Dateien aus dem Domänenmodell neu geschrieben — für Git-Lesbarkeit
 *     und Obsidian. Sie sind Projektion, nicht Wahrheit: Die App liest sie
 *     nach der Migration nie wieder, um UI zu füllen (SPEC §16); externe
 *     Edits kommen über Connectors zurück (obsidian-vault, git-backup).
 *
 * Das Frontmatter-Format ist unverändert zur Altfassung von
 * storage/docs.ts — bestehende Dateien bleiben byte-kompatibel, bis auf
 * dokumentierte Normalisierungen (Tag-Sortierung, leere optionale Felder).
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { Doc, DocFrontmatter, DocType } from '@/types/doc';
import type { Task, TasksData } from '@/lib/storage/tasks';
import type { Project, ProjectsData } from '@/lib/storage/projects';
import type { CanvasData, CanvasIndex } from '@/lib/storage/canvas';
import { readJsonSafe, writeFileAtomic, writeJsonAtomic } from '@/lib/storage/atomic';
import type { WorkspaceSnapshotInput } from '../migrate/from-files';

export interface WorkspaceFilePaths {
    docsDir: string;
    tasksFile: string;
    projectsFile: string;
    canvasDir: string;
}

export function defaultWorkspaceFilePaths(baseDir: string = path.join(process.cwd(), 'data')): WorkspaceFilePaths {
    return {
        docsDir: path.join(baseDir, 'docs'),
        tasksFile: path.join(baseDir, 'tasks', 'tasks.json'),
        projectsFile: path.join(baseDir, 'tasks', 'projects.json'),
        canvasDir: path.join(baseDir, 'canvas'),
    };
}

// --- Frontmatter (Format unverändert zur Altfassung) ---------------------

export function parseFrontmatter(content: string): { frontmatter: DocFrontmatter | null; body: string } {
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) {
        return { frontmatter: null, body: content };
    }
    const frontmatter: Record<string, string | string[]> = {};
    for (const line of match[1].split('\n')) {
        const colonIndex = line.indexOf(':');
        if (colonIndex === -1) continue;
        const key = line.slice(0, colonIndex).trim();
        let value = line.slice(colonIndex + 1).trim();
        if (value.startsWith('[') && value.endsWith(']')) {
            value = value.slice(1, -1);
            frontmatter[key] = value === ''
                ? []
                : value.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
        } else {
            frontmatter[key] = value.replace(/^["']|["']$/g, '');
        }
    }
    return {
        frontmatter: frontmatter as unknown as DocFrontmatter,
        body: match[2].trim(),
    };
}

export function generateFrontmatter(meta: DocFrontmatter): string {
    const lines = [
        '---',
        `id: "${meta.id}"`,
        `slug: "${meta.slug}"`,
        `title: "${meta.title}"`,
    ];
    if (meta.category) lines.push(`category: "${meta.category}"`);
    if (meta.author) lines.push(`author: "${meta.author}"`);
    if (meta.type) lines.push(`type: "${meta.type}"`);
    if (meta.inLanguage) lines.push(`inLanguage: "${meta.inLanguage}"`);
    const tagsStr = meta.tags.map(t => `"${t}"`).join(', ');
    lines.push(`tags: [${tagsStr}]`);
    lines.push(`createdAt: "${meta.createdAt}"`);
    lines.push(`updatedAt: "${meta.updatedAt}"`);
    lines.push('---');
    return lines.join('\n');
}

function docFileContent(doc: Doc): string {
    const { content, ...meta } = doc;
    return `${generateFrontmatter({ ...meta, tags: doc.tags })}\n\n${content}`;
}

// --- Bootstrap-Leser -----------------------------------------------------

async function readDocsFromDir(docsDir: string): Promise<Doc[]> {
    let entries: string[];
    try {
        entries = await fs.readdir(docsDir);
    } catch {
        return [];
    }
    const docs: Doc[] = [];
    for (const file of entries.filter(f => f.endsWith('.md')).sort()) {
        const raw = await fs.readFile(path.join(docsDir, file), 'utf-8');
        const { frontmatter, body } = parseFrontmatter(raw);
        if (frontmatter) {
            docs.push({ ...frontmatter, tags: frontmatter.tags || [], content: body });
        }
    }
    return docs;
}

async function readCanvasesFromDir(canvasDir: string): Promise<CanvasData[]> {
    const index = await readJsonSafe<CanvasIndex>(path.join(canvasDir, 'index.json'), { canvases: [] });
    const canvases: CanvasData[] = [];
    for (const entry of index.canvases) {
        const canvas = await readJsonSafe<CanvasData | null>(path.join(canvasDir, `${entry.id}.json`), null);
        if (canvas) canvases.push(canvas);
    }
    return canvases;
}

/**
 * Liest den kompletten Dateibestand für die (Re-)Migration in den Store.
 * Nur der Bootstrap und `bun run migrate:graph` benutzen das — kein
 * Laufzeit-Lesepfad der App führt mehr hierüber.
 */
export async function readWorkspaceFiles(paths: WorkspaceFilePaths = defaultWorkspaceFilePaths()): Promise<WorkspaceSnapshotInput> {
    const [docs, tasksData, projectsData, canvases] = await Promise.all([
        readDocsFromDir(paths.docsDir),
        readJsonSafe<TasksData>(paths.tasksFile, { tasks: [], version: 1 }),
        readJsonSafe<ProjectsData>(paths.projectsFile, { projects: [], version: 1 }),
        readCanvasesFromDir(paths.canvasDir),
    ]);
    return { docs, tasks: tasksData.tasks, projects: projectsData.projects, canvases };
}

// --- Projektions-Schreiber -----------------------------------------------

export interface ProjectionReport {
    writtenDocs: number;
    removedDocFiles: string[];
    writtenCanvases: number;
    removedCanvasFiles: string[];
}

function sanitizeCanvasFileId(id: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

/**
 * Schreibt die Datei-Projektion des Domänenmodells. `previous` liefert den
 * Stand vor der Mutation, damit umbenannte Slugs und gelöschte Entitäten
 * ihre Dateien verlieren. Dateien, die der Store nie kannte, bleiben
 * unangetastet — hier wird projiziert, nicht aufgeräumt.
 */
export async function projectWorkspaceFiles(
    input: WorkspaceSnapshotInput,
    previous: WorkspaceSnapshotInput | null,
    paths: WorkspaceFilePaths = defaultWorkspaceFilePaths(),
): Promise<ProjectionReport> {
    const report: ProjectionReport = {
        writtenDocs: 0,
        removedDocFiles: [],
        writtenCanvases: 0,
        removedCanvasFiles: [],
    };

    // Dokumente: eine Datei pro Slug; verwaiste Slugs des Vorzustands weichen.
    const currentSlugs = new Set(input.docs.map(doc => doc.slug));
    for (const doc of input.docs) {
        await writeFileAtomic(path.join(paths.docsDir, `${doc.slug}.md`), docFileContent(doc));
        report.writtenDocs += 1;
    }
    for (const prevDoc of previous?.docs ?? []) {
        if (!currentSlugs.has(prevDoc.slug)) {
            const stale = path.join(paths.docsDir, `${prevDoc.slug}.md`);
            await fs.rm(stale, { force: true });
            report.removedDocFiles.push(`${prevDoc.slug}.md`);
        }
    }

    await writeJsonAtomic(paths.tasksFile, { tasks: input.tasks, version: 1 } satisfies TasksData);
    await writeJsonAtomic(paths.projectsFile, { projects: input.projects, version: 1 } satisfies ProjectsData);

    // Canvases: Datei pro ID plus Index; gelöschte IDs verlieren die Datei.
    const currentCanvasIds = new Set(input.canvases.map(canvas => canvas.id));
    for (const canvas of input.canvases) {
        if (!sanitizeCanvasFileId(canvas.id)) continue;
        await writeJsonAtomic(path.join(paths.canvasDir, `${canvas.id}.json`), canvas);
        report.writtenCanvases += 1;
    }
    for (const prevCanvas of previous?.canvases ?? []) {
        if (!currentCanvasIds.has(prevCanvas.id) && sanitizeCanvasFileId(prevCanvas.id)) {
            await fs.rm(path.join(paths.canvasDir, `${prevCanvas.id}.json`), { force: true });
            report.removedCanvasFiles.push(`${prevCanvas.id}.json`);
        }
    }
    const index: CanvasIndex = {
        canvases: input.canvases.map(canvas => ({
            id: canvas.id,
            name: canvas.name,
            description: canvas.description,
            cardCount: canvas.cards.length,
            createdAt: canvas.createdAt,
            updatedAt: canvas.updatedAt,
        })),
    };
    await writeJsonAtomic(path.join(paths.canvasDir, 'index.json'), index);

    return report;
}

/** Re-Export der Domänentypen für Aufrufer der Datei-Ebene. */
export type { Doc, DocType, Task, Project, CanvasData, WorkspaceSnapshotInput };
