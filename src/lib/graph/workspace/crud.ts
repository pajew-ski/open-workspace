/**
 * Store-first-CRUD des Workspace (Abschluss SPEC §12.4).
 *
 * Jede Mutation läuft: Store lesen → Domänenmodell ändern → Store
 * schreiben (EINE Transaktion: Workspace-Graph ersetzt, Layout-Gruppen
 * ersetzt, Projekt-Farben ersetzt, Waisen bereinigt) → Dateien projizieren
 * → Snapshot persistieren. Der Store ist die Wahrheit, die Dateien sind
 * Projektion; `src/lib/storage/*` sind nur noch Fassaden hierüber.
 *
 * Lesepfade (list/get) kommen ausschließlich aus dem Store — die App
 * liest nie wieder direkt aus `data/*`-Dateien, um UI zu füllen
 * (SPEC §16). Externe Datei-Edits fließen über Connectors zurück
 * (obsidian-vault, git-backup — M6).
 */

import type { Doc, DocType } from '@/types/doc';
import type { Task, TaskDependency, TaskPriority, TaskStatus, TaskType } from '@/lib/storage/tasks';
import type { Project, ProjectStatus } from '@/lib/storage/projects';
import type { CanvasCard, CanvasConnection, CanvasData, CanvasIndex, ImportCanvasInput } from '@/lib/storage/canvas';
import type { GraphStore } from '../store/types';
import type { IriFactory } from '../iri';
import { namedNode } from '../rdf';
import { buildWorkspaceQuads, slugifyTitle, type MigrationCounts, type WorkspaceSnapshotInput } from '../migrate/from-files';
import {
    buildNativeCanvasLayout,
    pruneOrphanCanvasLayouts,
    replaceCanvasLayouts,
    replaceProjectPresentation,
} from '../presentation/layout';
import { workspaceFromStore } from './read';
import { projectWorkspaceFiles, type WorkspaceFilePaths } from './files';

export interface WorkspaceContext {
    store: GraphStore;
    iri: IriFactory;
    paths: WorkspaceFilePaths;
    /** Serialisiert Mutationen prozessweit (ein Schreiber pro Graph, SPEC §15). */
    runExclusive<T>(fn: () => Promise<T>): Promise<T>;
    /** Persistiert `data/graph/` nach jeder Mutation (deterministisch, git-tauglich). */
    persistSnapshot(): Promise<unknown>;
}

/**
 * Schreibt das Domänenmodell vollständig in den Store — Wissen nach
 * `graph/<u>/workspace`, Layout und Projekt-Farben nach
 * `graph/<u>/presentation`, in EINER Transaktion. Auch der Bootstrap
 * ((Re-)Migration aus Dateien) läuft hierüber: ein Schreibweg, keine
 * Sonderpipeline.
 */
export async function writeWorkspaceToStore(
    store: GraphStore,
    iri: IriFactory,
    input: WorkspaceSnapshotInput,
): Promise<MigrationCounts> {
    const { quads, counts } = buildWorkspaceQuads(input, iri);
    await store.transaction(async tx => {
        await tx.load(quads, namedNode(iri.graph('workspace')), { replace: true });
        await replaceCanvasLayouts(tx, iri, input.canvases.map(canvas => buildNativeCanvasLayout(canvas, iri)));
        await replaceProjectPresentation(tx, iri, input.projects);
        await pruneOrphanCanvasLayouts(tx, iri);
    });
    return counts;
}

/** Aktuelles Domänenmodell aus dem Store (Lesepfad der Fassaden). */
export async function readWorkspace(ctx: Pick<WorkspaceContext, 'store' | 'iri'>): Promise<WorkspaceSnapshotInput> {
    return workspaceFromStore(ctx.store, ctx.iri);
}

/**
 * Mutations-Grundmuster: Store lesen, Draft ändern, zurückschreiben,
 * projizieren, persistieren. `null` aus dem Mutator heißt „Ziel existiert
 * nicht" — dann wird nichts geschrieben.
 */
async function mutate<T>(
    ctx: WorkspaceContext,
    mutator: (draft: WorkspaceSnapshotInput) => T | null,
): Promise<T | null> {
    return ctx.runExclusive(async () => {
        const previous = await workspaceFromStore(ctx.store, ctx.iri);
        const draft = structuredClone(previous);
        const result = mutator(draft);
        if (result === null) return null;
        await writeWorkspaceToStore(ctx.store, ctx.iri, draft);
        await projectWorkspaceFiles(draft, previous, ctx.paths);
        await ctx.persistSnapshot();
        return result;
    });
}

function randomSuffix(): string {
    return Math.random().toString(36).slice(2, 8);
}

function nowIso(): string {
    return new Date().toISOString();
}

// --- Dokumente -----------------------------------------------------------

export async function listDocs(ctx: WorkspaceContext): Promise<Doc[]> {
    const { docs } = await readWorkspace(ctx);
    return docs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export async function getDoc(ctx: WorkspaceContext, id: string): Promise<Doc | null> {
    return (await readWorkspace(ctx)).docs.find(doc => doc.id === id) ?? null;
}

export async function getDocBySlug(ctx: WorkspaceContext, slug: string): Promise<Doc | null> {
    return (await readWorkspace(ctx)).docs.find(doc => doc.slug === slug) ?? null;
}

export interface CreateDocInput {
    title: string;
    content: string;
    category?: string;
    type?: DocType;
    tags?: string[];
}

export async function createDoc(ctx: WorkspaceContext, data: CreateDocInput): Promise<Doc> {
    const now = nowIso();
    const doc: Doc = {
        id: `doc-${Date.now()}-${randomSuffix()}`,
        slug: slugifyTitle(data.title),
        title: data.title,
        content: data.content,
        category: data.category,
        tags: data.tags ?? [],
        type: data.type ?? 'CreativeWork',
        author: 'default-author',
        inLanguage: 'de',
        createdAt: now,
        updatedAt: now,
    };
    await mutate(ctx, draft => {
        draft.docs.push(doc);
        return doc;
    });
    return doc;
}

export interface UpdateDocInput {
    title?: string;
    content?: string;
    category?: string;
    tags?: string[];
    type?: DocType;
    slug?: string;
}

export async function updateDoc(ctx: WorkspaceContext, id: string, data: UpdateDocInput): Promise<Doc | null> {
    return mutate(ctx, draft => {
        const index = draft.docs.findIndex(doc => doc.id === id);
        if (index === -1) return null;
        const existing = draft.docs[index];
        const updated: Doc = {
            ...existing,
            title: data.title ?? existing.title,
            content: data.content ?? existing.content,
            category: data.category ?? existing.category,
            tags: data.tags ?? existing.tags,
            type: data.type ?? existing.type,
            slug: data.slug ?? existing.slug,
            updatedAt: nowIso(),
        };
        draft.docs[index] = updated;
        return updated;
    });
}

export async function deleteDoc(ctx: WorkspaceContext, id: string): Promise<boolean> {
    const result = await mutate(ctx, draft => {
        const index = draft.docs.findIndex(doc => doc.id === id);
        if (index === -1) return null;
        draft.docs.splice(index, 1);
        return true;
    });
    return result === true;
}

// --- Aufgaben ------------------------------------------------------------

export interface TaskFilter {
    status?: TaskStatus;
    projectId?: string;
}

export async function listTasks(ctx: WorkspaceContext, filter?: TaskFilter): Promise<Task[]> {
    let { tasks } = await readWorkspace(ctx);
    if (filter?.status) tasks = tasks.filter(task => task.status === filter.status);
    if (filter?.projectId) tasks = tasks.filter(task => task.projectId === filter.projectId);
    return tasks.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export async function getTask(ctx: WorkspaceContext, id: string): Promise<Task | null> {
    return (await readWorkspace(ctx)).tasks.find(task => task.id === id) ?? null;
}

export interface CreateTaskInput {
    title: string;
    description?: string;
    status?: TaskStatus;
    priority?: TaskPriority;
    type?: TaskType;
    startDate?: string;
    dueDate?: string;
    deferredUntil?: string;
    estimatedEffort?: number;
    projectId?: string;
    tags?: string[];
    dependencies?: TaskDependency[];
}

export async function createTask(ctx: WorkspaceContext, input: CreateTaskInput): Promise<Task> {
    const now = nowIso();
    const task: Task = {
        id: `task-${Date.now()}-${randomSuffix()}`,
        title: input.title,
        description: input.description,
        status: input.status ?? 'todo',
        priority: input.priority ?? 'medium',
        type: input.type ?? 'task',
        startDate: input.startDate,
        dueDate: input.dueDate,
        deferredUntil: input.deferredUntil,
        estimatedEffort: input.estimatedEffort,
        projectId: input.projectId,
        tags: input.tags ?? [],
        dependencies: input.dependencies ?? [],
        createdAt: now,
        updatedAt: now,
    };
    await mutate(ctx, draft => {
        draft.tasks.push(task);
        return task;
    });
    return task;
}

export async function updateTask(
    ctx: WorkspaceContext,
    id: string,
    input: Partial<Omit<Task, 'id' | 'createdAt'>>,
): Promise<Task | null> {
    return mutate(ctx, draft => {
        const index = draft.tasks.findIndex(task => task.id === id);
        if (index === -1) return null;
        const existing = draft.tasks[index];
        const now = nowIso();
        // Abschluss-Zeitpunkt: gesetzt beim Übergang nach 'done', danach
        // erhalten — Semantik unverändert zur Altfassung.
        const completedAt = input.status === 'done' && existing.status !== 'done'
            ? now
            : (input.status && input.status !== 'done' ? undefined : existing.completedAt);
        const updated: Task = {
            ...existing,
            ...input,
            completedAt: completedAt || existing.completedAt,
            updatedAt: now,
        };
        draft.tasks[index] = updated;
        return updated;
    });
}

export async function deleteTask(ctx: WorkspaceContext, id: string): Promise<boolean> {
    const result = await mutate(ctx, draft => {
        const index = draft.tasks.findIndex(task => task.id === id);
        if (index === -1) return null;
        draft.tasks.splice(index, 1);
        return true;
    });
    return result === true;
}

export async function getTasksByStatus(ctx: WorkspaceContext): Promise<Record<string, Task[]>> {
    const tasks = await listTasks(ctx);
    return {
        'backlog': tasks.filter(t => t.status === 'backlog'),
        'todo': tasks.filter(t => t.status === 'todo'),
        'in-progress': tasks.filter(t => t.status === 'in-progress'),
        'review': tasks.filter(t => t.status === 'review'),
        'done': tasks.filter(t => t.status === 'done'),
        'on-hold': tasks.filter(t => t.status === 'on-hold'),
    };
}

// --- Projekte ------------------------------------------------------------

export async function listProjects(ctx: WorkspaceContext): Promise<Project[]> {
    const { projects } = await readWorkspace(ctx);
    return projects.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export async function getProject(ctx: WorkspaceContext, id: string): Promise<Project | null> {
    return (await readWorkspace(ctx)).projects.find(project => project.id === id) ?? null;
}

export interface CreateProjectInput {
    title: string;
    description?: string;
    prefix: string;
    status?: ProjectStatus;
    color?: string;
}

export async function createProject(ctx: WorkspaceContext, input: CreateProjectInput): Promise<Project> {
    const now = nowIso();
    const project: Project = {
        id: `proj-${Date.now()}-${randomSuffix()}`,
        title: input.title,
        description: input.description,
        prefix: input.prefix.toUpperCase(),
        status: input.status ?? 'planning',
        color: input.color ?? '#00674F',
        createdAt: now,
        updatedAt: now,
    };
    await mutate(ctx, draft => {
        draft.projects.push(project);
        return project;
    });
    return project;
}

export async function updateProject(
    ctx: WorkspaceContext,
    id: string,
    input: Partial<Omit<Project, 'id' | 'createdAt'>>,
): Promise<Project | null> {
    return mutate(ctx, draft => {
        const index = draft.projects.findIndex(project => project.id === id);
        if (index === -1) return null;
        const updated: Project = { ...draft.projects[index], ...input, updatedAt: nowIso() };
        draft.projects[index] = updated;
        return updated;
    });
}

export async function deleteProject(ctx: WorkspaceContext, id: string): Promise<boolean> {
    const result = await mutate(ctx, draft => {
        const index = draft.projects.findIndex(project => project.id === id);
        if (index === -1) return null;
        draft.projects.splice(index, 1);
        return true;
    });
    return result === true;
}

// --- Canvas --------------------------------------------------------------

export async function listCanvases(ctx: WorkspaceContext): Promise<CanvasIndex['canvases']> {
    const { canvases } = await readWorkspace(ctx);
    return canvases
        .map(canvas => ({
            id: canvas.id,
            name: canvas.name,
            description: canvas.description,
            cardCount: canvas.cards.length,
            createdAt: canvas.createdAt,
            updatedAt: canvas.updatedAt,
        }))
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export async function getCanvas(ctx: WorkspaceContext, id: string): Promise<CanvasData | null> {
    return (await readWorkspace(ctx)).canvases.find(canvas => canvas.id === id) ?? null;
}

export async function createCanvas(ctx: WorkspaceContext, name: string, description?: string): Promise<CanvasData> {
    const now = nowIso();
    const canvas: CanvasData = {
        id: `canvas-${Date.now()}-${randomSuffix()}`,
        name,
        description,
        cards: [],
        connections: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        createdAt: now,
        updatedAt: now,
    };
    await mutate(ctx, draft => {
        draft.canvases.push(canvas);
        return canvas;
    });
    return canvas;
}

export async function importCanvas(ctx: WorkspaceContext, input: ImportCanvasInput): Promise<CanvasData> {
    const now = nowIso();
    const canvas: CanvasData = {
        id: `canvas-${Date.now()}-${randomSuffix()}`,
        name: input.name,
        description: input.description,
        cards: input.cards.map(card => ({ ...card, createdAt: now, updatedAt: now })),
        connections: input.connections,
        viewport: { x: 0, y: 0, zoom: 1 },
        createdAt: now,
        updatedAt: now,
    };
    await mutate(ctx, draft => {
        draft.canvases.push(canvas);
        return canvas;
    });
    return canvas;
}

export async function updateCanvasMeta(
    ctx: WorkspaceContext,
    id: string,
    updates: { name?: string; description?: string },
): Promise<CanvasData | null> {
    return mutateCanvas(ctx, id, canvas => {
        if (updates.name !== undefined) canvas.name = updates.name;
        if (updates.description !== undefined) canvas.description = updates.description;
        return canvas;
    });
}

export async function deleteCanvas(ctx: WorkspaceContext, id: string): Promise<boolean> {
    const result = await mutate(ctx, draft => {
        const index = draft.canvases.findIndex(canvas => canvas.id === id);
        if (index === -1) return null;
        draft.canvases.splice(index, 1);
        return true;
    });
    return result === true;
}

/** Gemeinsames Muster der Canvas-Detail-Mutationen (aktualisiert updatedAt). */
async function mutateCanvas<T>(
    ctx: WorkspaceContext,
    canvasId: string,
    mutator: (canvas: CanvasData) => T | null,
): Promise<T | null> {
    return mutate(ctx, draft => {
        const canvas = draft.canvases.find(c => c.id === canvasId);
        if (!canvas) return null;
        const result = mutator(canvas);
        if (result === null) return null;
        canvas.updatedAt = nowIso();
        return result;
    });
}

export interface CreateCardInput {
    type?: CanvasCard['type'];
    title: string;
    content?: string;
    x: number;
    y: number;
    width?: number;
    height?: number;
    color?: string;
}

export async function createCard(ctx: WorkspaceContext, canvasId: string, input: CreateCardInput): Promise<CanvasCard | null> {
    const now = nowIso();
    return mutateCanvas(ctx, canvasId, canvas => {
        const card: CanvasCard = {
            id: `card-${Date.now()}-${randomSuffix()}`,
            type: input.type ?? 'note',
            title: input.title,
            content: input.content,
            x: input.x,
            y: input.y,
            width: input.width ?? 240,
            height: input.height ?? 180,
            color: input.color,
            createdAt: now,
            updatedAt: now,
        };
        canvas.cards.push(card);
        return card;
    });
}

export async function updateCard(
    ctx: WorkspaceContext,
    canvasId: string,
    cardId: string,
    updates: Partial<Omit<CanvasCard, 'id' | 'createdAt'>>,
): Promise<CanvasCard | null> {
    return mutateCanvas(ctx, canvasId, canvas => {
        const index = canvas.cards.findIndex(card => card.id === cardId);
        if (index === -1) return null;
        canvas.cards[index] = { ...canvas.cards[index], ...updates, updatedAt: nowIso() };
        return canvas.cards[index];
    });
}

export async function deleteCard(ctx: WorkspaceContext, canvasId: string, cardId: string): Promise<boolean> {
    const result = await mutateCanvas(ctx, canvasId, canvas => {
        const index = canvas.cards.findIndex(card => card.id === cardId);
        if (index === -1) return null;
        canvas.cards.splice(index, 1);
        canvas.connections = canvas.connections.filter(c => c.fromId !== cardId && c.toId !== cardId);
        return true;
    });
    return result === true;
}

export async function createConnection(
    ctx: WorkspaceContext,
    canvasId: string,
    fromId: string,
    toId: string,
    type: CanvasConnection['type'] = 'directional',
    label?: string,
): Promise<CanvasConnection | null> {
    return mutateCanvas(ctx, canvasId, canvas => {
        if (!canvas.cards.some(card => card.id === fromId) || !canvas.cards.some(card => card.id === toId)) {
            return null;
        }
        const connection: CanvasConnection = { id: `conn-${Date.now()}`, fromId, toId, type, label };
        canvas.connections.push(connection);
        return connection;
    });
}

export async function updateConnection(
    ctx: WorkspaceContext,
    canvasId: string,
    connectionId: string,
    updates: Partial<Omit<CanvasConnection, 'id'>>,
): Promise<CanvasConnection | null> {
    return mutateCanvas(ctx, canvasId, canvas => {
        const index = canvas.connections.findIndex(connection => connection.id === connectionId);
        if (index === -1) return null;
        canvas.connections[index] = { ...canvas.connections[index], ...updates };
        return canvas.connections[index];
    });
}

export async function deleteConnection(ctx: WorkspaceContext, canvasId: string, connectionId: string): Promise<boolean> {
    const result = await mutateCanvas(ctx, canvasId, canvas => {
        const index = canvas.connections.findIndex(connection => connection.id === connectionId);
        if (index === -1) return null;
        canvas.connections.splice(index, 1);
        return true;
    });
    return result === true;
}

export async function updateViewport(ctx: WorkspaceContext, canvasId: string, viewport: CanvasData['viewport']): Promise<void> {
    await mutateCanvas(ctx, canvasId, canvas => {
        canvas.viewport = viewport;
        return true;
    });
}
