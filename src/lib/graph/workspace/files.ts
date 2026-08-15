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
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Doc, DocFrontmatter, DocType } from '@/types/doc';
import type { Task, TasksData } from '@/lib/storage/tasks';
import type { Project, ProjectsData } from '@/lib/storage/projects';
import type { CanvasData, CanvasIndex } from '@/lib/storage/canvas';
import type { CalendarEvent, CalendarProvider } from '@/lib/storage/calendar';
import type { Conversation, ConversationsData } from '@/lib/storage/chat';
import { readJsonSafe, writeFileAtomic, writeJsonAtomic } from '@/lib/storage/atomic';
import type { WorkspaceSnapshotInput } from '../migrate/from-files';
import { DEFAULT_USER_ID } from '../iri';

export interface WorkspaceFilePaths {
    docsDir: string;
    tasksFile: string;
    projectsFile: string;
    canvasDir: string;
    calendarProvidersFile: string;
    calendarEventsFile: string;
    conversationsFile: string;
}

export function defaultWorkspaceFilePaths(baseDir: string = path.join(process.cwd(), 'data')): WorkspaceFilePaths {
    return {
        docsDir: path.join(baseDir, 'docs'),
        tasksFile: path.join(baseDir, 'tasks', 'tasks.json'),
        projectsFile: path.join(baseDir, 'tasks', 'projects.json'),
        canvasDir: path.join(baseDir, 'canvas'),
        calendarProvidersFile: path.join(baseDir, 'calendar', 'providers.json'),
        calendarEventsFile: path.join(baseDir, 'calendar', 'events.json'),
        conversationsFile: path.join(baseDir, 'chat', 'conversations.json'),
    };
}

/**
 * Projektions-Pfade eines Nutzers (SPEC §17, M13). Der Einzelnutzer der
 * Installation behält das flache Layout aus §8.1 — sonst wäre der Umstieg
 * auf Mehrbenutzerbetrieb eine Datei-Migration, und genau das soll er
 * nicht sein (§16.5). Jeder weitere Nutzer bekommt seinen eigenen Baum
 * unter `data/u/<userId>/`, damit eine Datei-Projektion nie die eines
 * anderen überschreibt (§17.4 „Export und Git-Sync").
 */
export function workspaceFilePathsFor(
    userId: string,
    baseDir: string = path.join(process.cwd(), 'data'),
): WorkspaceFilePaths {
    if (userId === DEFAULT_USER_ID) return defaultWorkspaceFilePaths(baseDir);
    const userDir = path.join(baseDir, 'u', userId.replace(/[^A-Za-z0-9._@-]+/g, '-'));
    return defaultWorkspaceFilePaths(userDir);
}

// --- Frontmatter (YAML, Ausgabeformat unverändert zur Altfassung) --------

/**
 * Gelesen und geschrieben wird mit `yaml` — derselben Bibliothek, die der
 * Obsidian-Connector schon benutzt (ANALYSE §5 P0.4). Der handgeschriebene
 * Vorgänger las jede Zeile als `key: wert`, strippte Anführungszeichen an
 * den Rändern und zerlegte `[a, b]` am Komma. Er scheiterte damit an genau
 * dem, was in echten Titeln vorkommt: einem Doppelpunkt im Wert
 * (`title: "Teil 1: Anfang"` wurde zu `Teil 1`), einem Komma innerhalb
 * eines Tags, einem Anführungszeichen im Text (er schrieb unparsbares
 * YAML) und mehrzeiligen Werten.
 *
 * Das **Ausgabeformat bleibt byte-gleich**: dieselbe Schlüsselreihenfolge,
 * doppelte Anführungszeichen, Tags als Flow-Liste `["a", "b"]`. Neu ist
 * allein, dass Sonderzeichen korrekt maskiert werden — vorher entstand
 * dort eine kaputte Datei, jetzt eine gültige.
 */
const YAML_SCALAR_OPTIONS = { defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN', lineWidth: 0 } as const;

/** Ein Wert als YAML-Skalar, ohne abschließenden Zeilenumbruch. */
function yamlScalar(value: string): string {
    return stringifyYaml(value, YAML_SCALAR_OPTIONS).trimEnd();
}

/**
 * Frontmatter-Werte kommen aus YAML mit Typen (Zahl, Boolean, null). Das
 * Dokumentmodell kennt nur Strings und String-Listen, und eine `1` in
 * einem Titel ist ein Titel — deshalb wird flach zu String verdichtet
 * statt die Datei abzulehnen. Verschachteltes bleibt draußen: Dafür gibt
 * es den Obsidian-Weg mit dem fm:-Namensraum, hier wäre es Erfindung.
 */
function toFrontmatterValue(value: unknown): string | string[] | undefined {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
        return value
            .filter(entry => entry !== null && entry !== undefined && typeof entry !== 'object')
            .map(entry => String(entry));
    }
    return undefined;
}

export interface ParsedFrontmatter {
    frontmatter: DocFrontmatter | null;
    body: string;
    /** Gesetzt, wenn ein Block DA war, aber kein gültiges YAML-Mapping ist. */
    error?: string;
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
    if (!match) {
        return { frontmatter: null, body: content };
    }
    const body = match[2].trim();

    let parsed: unknown;
    try {
        parsed = parseYaml(match[1]);
    } catch (error) {
        return { frontmatter: null, body, error: error instanceof Error ? error.message : 'unlesbares YAML' };
    }
    if (parsed === null || parsed === undefined) {
        return { frontmatter: {} as unknown as DocFrontmatter, body };
    }
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { frontmatter: null, body, error: 'kein YAML-Mapping (Key: Wert)' };
    }

    const frontmatter: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const normalized = toFrontmatterValue(value);
        if (normalized !== undefined) frontmatter[key] = normalized;
    }
    return { frontmatter: frontmatter as unknown as DocFrontmatter, body };
}

export function generateFrontmatter(meta: DocFrontmatter): string {
    const lines = [
        '---',
        `id: ${yamlScalar(meta.id)}`,
        `slug: ${yamlScalar(meta.slug)}`,
        `title: ${yamlScalar(meta.title)}`,
    ];
    if (meta.category) lines.push(`category: ${yamlScalar(meta.category)}`);
    if (meta.author) lines.push(`author: ${yamlScalar(meta.author)}`);
    if (meta.type) lines.push(`type: ${yamlScalar(meta.type)}`);
    if (meta.inLanguage) lines.push(`inLanguage: ${yamlScalar(meta.inLanguage)}`);
    lines.push(`tags: [${meta.tags.map(yamlScalar).join(', ')}]`);
    lines.push(`createdAt: ${yamlScalar(meta.createdAt)}`);
    lines.push(`updatedAt: ${yamlScalar(meta.updatedAt)}`);
    lines.push('---');
    return lines.join('\n');
}

function docFileContent(doc: Doc): string {
    const { content, ...meta } = doc;
    return `${generateFrontmatter({ ...meta, tags: doc.tags })}\n\n${content}`;
}

// --- Bootstrap-Leser -----------------------------------------------------

/**
 * Ohne diese Felder gibt es kein Dokument: `id` trägt die IRI, `slug` den
 * Dateinamen, die Zeitstempel die Ordnung. Fehlt eines, entstünde eine
 * Entität mit `undefined` im Bezeichner — schlimmer als gar keine.
 */
const REQUIRED_FRONTMATTER_KEYS = ['id', 'slug', 'title', 'createdAt', 'updatedAt'] as const;

/**
 * Eine Markdown-Datei zu einem Dokument machen — oder begründen, warum
 * nicht. Vorher fiel eine Datei ohne Frontmatter hier stillschweigend
 * heraus: Sie lag sichtbar in `data/docs`, tauchte aber in keiner
 * Ansicht und keinem Graphen auf, und nichts sagte einem das. Genau die
 * Sorte Attrappe, die dieses Repo nicht haben will.
 */
export function docFromMarkdown(raw: string): { doc: Doc } | { skipped: string } {
    const { frontmatter, body, error } = parseFrontmatter(raw);
    if (error) {
        return { skipped: `Frontmatter ist kein gültiges YAML: ${error}` };
    }
    if (!frontmatter) {
        return { skipped: 'kein Frontmatter (--- am Dateianfang)' };
    }
    const missing = REQUIRED_FRONTMATTER_KEYS.filter(key => {
        const value = frontmatter[key];
        return typeof value !== 'string' || value.trim() === '';
    });
    if (missing.length > 0) {
        return { skipped: `Frontmatter unvollständig, fehlt: ${missing.join(', ')}` };
    }
    return { doc: { ...frontmatter, tags: frontmatter.tags || [], content: body } };
}

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
        const result = docFromMarkdown(raw);
        if ('doc' in result) {
            docs.push(result.doc);
            continue;
        }
        console.warn(`[workspace] ${path.join(docsDir, file)} wird übergangen: ${result.skipped}`);
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
    const [docs, tasksData, projectsData, canvases, providersData, eventsData, chatData] = await Promise.all([
        readDocsFromDir(paths.docsDir),
        readJsonSafe<TasksData>(paths.tasksFile, { tasks: [], version: 1 }),
        readJsonSafe<ProjectsData>(paths.projectsFile, { projects: [], version: 1 }),
        readCanvasesFromDir(paths.canvasDir),
        readJsonSafe<CalendarProvidersData>(paths.calendarProvidersFile, { providers: [] }),
        readJsonSafe<CalendarEventsData>(paths.calendarEventsFile, { events: [] }),
        readJsonSafe<ConversationsData>(paths.conversationsFile, { conversations: [], activeId: null }),
    ]);
    const calendars = providersData.providers ?? [];
    // Termine ohne ihren Kalender bekämen eine Kante ins Leere — sie
    // stammen aus einer Datei, die den Provider nicht mehr kennt.
    const known = new Set(calendars.map(calendar => calendar.id));
    return {
        docs,
        tasks: tasksData.tasks,
        projects: projectsData.projects,
        canvases,
        calendars,
        events: (eventsData.events ?? []).filter(event => known.has(event.providerId)),
        conversations: chatData.conversations ?? [],
        activeConversationId: chatData.activeId ?? null,
    };
}

// --- Projektions-Schreiber -----------------------------------------------

export interface ProjectionReport {
    writtenDocs: number;
    removedDocFiles: string[];
    writtenCanvases: number;
    removedCanvasFiles: string[];
}

/** Dateiform von `data/calendar/providers.json` (Projektion). */
export interface CalendarProvidersData {
    providers: CalendarProvider[];
}

/** Dateiform von `data/calendar/events.json` (Projektion). */
export interface CalendarEventsData {
    events: CalendarEvent[];
    updatedAt?: string;
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

    // Kalender und Chats (M15). Bewusst ohne den früheren `updatedAt`-
    // Stempel in events.json: Die Projektion ist deterministisch, damit
    // eine Mutation ohne Inhaltsänderung keinen Git-Diff erzeugt.
    await writeJsonAtomic(paths.calendarProvidersFile, { providers: input.calendars } satisfies CalendarProvidersData);
    await writeJsonAtomic(paths.calendarEventsFile, { events: input.events } satisfies CalendarEventsData);
    await writeJsonAtomic(paths.conversationsFile, {
        conversations: input.conversations,
        activeId: input.activeConversationId ?? null,
    } satisfies ConversationsData);

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
export type {
    Doc, DocType, Task, Project, CanvasData, CalendarProvider, CalendarEvent, Conversation,
    WorkspaceSnapshotInput,
};
