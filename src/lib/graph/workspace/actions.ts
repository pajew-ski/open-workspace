/**
 * Aktionen des Workspace (ACTIONS_SPEC): Aufgaben, Projekte, Dokumente,
 * Pinnwände. Jede Fähigkeit steht hier genau einmal — Route,
 * Tool-Definition, MCP-Werkzeug und Selbstmodell leiten sich daraus ab.
 *
 * Die Zod-Schemas lagen bis A1 in `src/lib/api/validation.ts` neben
 * handgeschriebenen JSON-Schemas in `tools.shared.ts`; jetzt sind sie
 * Teil der jeweiligen Aktion, und das JSON-Schema wird erzeugt.
 *
 * Ziel jeder Aktion ist der eigene Workspace-Graph (SPEC §3.3:
 * „UI, Agent, API des Eigentümers"); Pinnwand-Layouts liegen im
 * Präsentationsgraphen, den die Store-first-CRUD in derselben Transaktion
 * schreibt. Die Erlaubnis kommt aus dem Grant (`actions/authorize.ts`),
 * nicht aus diesen Definitionen.
 */

import { z } from 'zod';
import { defineAction, notFound, type ActionContext } from '@/lib/actions/contract';
import { registerActions } from '@/lib/actions/registry';
import { OW, SCHEMA } from '../vocab';
import * as crud from './crud';
import { syncCalendar } from './calendar-sync';
import { httpUrlSchema } from '@/lib/api/validation';
import { parseJsonCanvas } from '../connectors/json-canvas/format';
import { jsonCanvasToNative } from '../connectors/json-canvas/native';
import { ActionError } from '@/lib/actions/contract';

async function workspaceOf(ctx: ActionContext) {
    // `requires: ['workspace']` garantiert die Funktion; der Vertrag
    // prüft das vor dem Aufruf (authorize.ts#missingDependency).
    return ctx.workspace!();
}

/** ISO-artiges Datum; leer erlaubt (das Frontend schickt '' für gelöschte Daten). */
const dateStringSchema = z
    .string()
    .max(40)
    .refine(value => value === '' || !Number.isNaN(Date.parse(value)), 'Ungültiges Datum');

const idSchema = z.string().min(1).max(200);

// ---------------------------------------------------------------------------
// Aufgaben
// ---------------------------------------------------------------------------

export const taskStatusSchema = z.enum(['backlog', 'todo', 'in-progress', 'review', 'done', 'on-hold']);
export const taskPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent']);
export const taskTypeSchema = z.enum(['task', 'bug', 'feature', 'milestone']);

const taskDependencySchema = z.object({
    id: idSchema,
    type: z.enum(['FS', 'SS', 'FF', 'SF']),
});

export const createTaskSchema = z.object({
    title: z.string().min(1, 'Titel ist erforderlich').max(500).describe('Titel der Aufgabe'),
    description: z.string().max(50_000).optional().describe('Beschreibung (Markdown erlaubt)'),
    status: taskStatusSchema.optional().describe('Status der Aufgabe'),
    priority: taskPrioritySchema.optional().describe('Priorität'),
    type: taskTypeSchema.optional().describe('Art der Aufgabe'),
    startDate: dateStringSchema.optional().describe('Start als ISO-Datum'),
    dueDate: dateStringSchema.optional().describe('Fälligkeit als ISO-Datum (YYYY-MM-DD)'),
    deferredUntil: dateStringSchema.optional().describe('Zurückgestellt bis (ISO-Datum)'),
    estimatedEffort: z.number().min(0).max(100_000).optional().describe('Geschätzter Aufwand in Stunden'),
    projectId: z.string().max(200).optional().describe('ID des Projekts, zu dem die Aufgabe gehört'),
    tags: z.array(z.string().max(100)).max(100).optional(),
    dependencies: z.array(taskDependencySchema).max(100).optional(),
});

export const updateTaskSchema = createTaskSchema
    .partial()
    .extend({
        actualEffort: z.number().min(0).max(100_000).optional().describe('Tatsächlicher Aufwand in Stunden'),
    });

export const CREATE_TASK_TOOL_NAME = 'workspace_create_task';
export const UPDATE_TASK_TOOL_NAME = 'workspace_update_task';

export const listTasks = defineAction({
    name: 'workspace_list_tasks',
    title: 'Aufgaben auflisten',
    description: 'Listet Aufgaben, optional nach Status oder Projekt gefiltert oder nach Status gruppiert.',
    input: z.object({
        status: taskStatusSchema.optional().describe('Nur Aufgaben mit diesem Status'),
        projectId: z.string().max(200).optional().describe('Nur Aufgaben dieses Projekts'),
        groupBy: z.enum(['status']).optional().describe('Gruppiert nach Status (Kanban)'),
        limit: z.number().int().min(1).max(500).optional().describe('Maximale Anzahl (Default 100)'),
    }),
    effect: 'read',
    target: { kind: 'graph', scope: 'workspace' },
    requires: ['workspace'],
    async run(input, ctx) {
        const workspace = await workspaceOf(ctx);
        if (input.groupBy === 'status') {
            return { tasks: await crud.getTasksByStatus(workspace) };
        }
        const tasks = await crud.listTasks(workspace, { status: input.status, projectId: input.projectId || undefined });
        return { tasks: tasks.slice(0, input.limit ?? 100) };
    },
});

export const getTask = defineAction({
    name: 'workspace_get_task',
    title: 'Aufgabe lesen',
    description: 'Liest eine Aufgabe mit allen Feldern.',
    input: z.object({ id: idSchema.describe('ID der Aufgabe') }),
    effect: 'read',
    target: { kind: 'graph', scope: 'workspace' },
    requires: ['workspace'],
    async run(input, ctx) {
        const task = await crud.getTask(await workspaceOf(ctx), input.id);
        if (!task) throw notFound('Aufgabe nicht gefunden');
        return { task };
    },
});

export const createTask = defineAction({
    name: CREATE_TASK_TOOL_NAME,
    title: 'Aufgabe anlegen',
    description: 'Legt eine neue Aufgabe im Workspace an.',
    input: createTaskSchema,
    effect: 'constructive',
    target: { kind: 'graph', scope: 'workspace' },
    requires: ['workspace'],
    changes: [OW.Task],
    async run(input, ctx) {
        const task = await crud.createTask(await workspaceOf(ctx), input);
        await ctx.activity?.('task_created', task.id, `Aufgabe erstellt: ${task.title}`);
        return { task };
    },
});

export const updateTask = defineAction({
    name: UPDATE_TASK_TOOL_NAME,
    title: 'Aufgabe ändern',
    description: `Ändert eine vorhandene Aufgabe. Die ID kommt aus ${'workspace_finder'} oder workspace_list_tasks.`,
    input: updateTaskSchema.extend({ taskId: idSchema.describe('ID der Aufgabe') }),
    effect: 'constructive',
    target: { kind: 'graph', scope: 'workspace' },
    requires: ['workspace'],
    changes: [OW.Task],
    async run(input, ctx) {
        const { taskId, ...fields } = input;
        if (Object.keys(fields).length === 0) {
            throw new ActionError(400, 'Es wurde kein zu änderndes Feld angegeben.');
        }
        const task = await crud.updateTask(await workspaceOf(ctx), taskId, fields);
        if (!task) throw notFound('Aufgabe nicht gefunden');
        await ctx.activity?.('task_updated', task.id, `Aufgabe aktualisiert: ${task.title}`);
        return { task };
    },
});

export const deleteTask = defineAction({
    name: 'workspace_delete_task',
    title: 'Aufgabe löschen',
    description: 'Löscht eine Aufgabe endgültig.',
    input: z.object({ id: idSchema }),
    effect: 'destructive',
    target: { kind: 'graph', scope: 'workspace' },
    requires: ['workspace'],
    changes: [OW.Task],
    async run(input, ctx) {
        const workspace = await workspaceOf(ctx);
        const task = await crud.getTask(workspace, input.id);
        const success = await crud.deleteTask(workspace, input.id);
        if (!success) throw notFound('Aufgabe nicht gefunden');
        if (task) await ctx.activity?.('task_deleted', input.id, `Aufgabe gelöscht: ${task.title}`);
        return { success: true as const };
    },
});

// ---------------------------------------------------------------------------
// Projekte
// ---------------------------------------------------------------------------

export const projectStatusSchema = z.enum(['planning', 'active', 'completed', 'archived']);

export const createProjectSchema = z.object({
    title: z.string().min(1, 'Titel ist erforderlich').max(300).describe('Titel des Projekts'),
    description: z.string().max(10_000).optional(),
    prefix: z.string().min(1, 'Präfix ist erforderlich').max(20).describe('Kurzes Präfix für Aufgaben-Nummern'),
    status: projectStatusSchema.optional(),
    color: z.string().max(50).optional().describe('Farbe (CSS-Wert)'),
});

export const updateProjectSchema = createProjectSchema.partial();

export const listProjects = defineAction({
    name: 'workspace_list_projects',
    title: 'Projekte auflisten',
    description: 'Listet alle Projekte des Workspace.',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'graph', scope: 'workspace' },
    requires: ['workspace'],
    async run(_input, ctx) {
        return { projects: await crud.listProjects(await workspaceOf(ctx)) };
    },
});

export const getProject = defineAction({
    name: 'workspace_get_project',
    title: 'Projekt lesen',
    description: 'Liest ein Projekt.',
    input: z.object({ id: idSchema.describe('ID des Projekts') }),
    effect: 'read',
    target: { kind: 'graph', scope: 'workspace' },
    requires: ['workspace'],
    async run(input, ctx) {
        const project = await crud.getProject(await workspaceOf(ctx), input.id);
        if (!project) throw notFound('Projekt nicht gefunden');
        return { project };
    },
});

export const createProject = defineAction({
    name: 'workspace_create_project',
    title: 'Projekt anlegen',
    description: 'Legt ein neues Projekt an.',
    input: createProjectSchema,
    effect: 'constructive',
    target: { kind: 'graph', scope: 'workspace' },
    requires: ['workspace'],
    changes: [OW.Project],
    async run(input, ctx) {
        const project = await crud.createProject(await workspaceOf(ctx), input);
        await ctx.activity?.('project_created', project.id, `Projekt erstellt: ${project.title}`);
        return { project };
    },
});

export const updateProject = defineAction({
    name: 'workspace_update_project',
    title: 'Projekt ändern',
    description: 'Ändert ein vorhandenes Projekt.',
    input: updateProjectSchema.extend({ projectId: idSchema.describe('ID des Projekts') }),
    effect: 'constructive',
    target: { kind: 'graph', scope: 'workspace' },
    requires: ['workspace'],
    changes: [OW.Project],
    async run(input, ctx) {
        const { projectId, ...fields } = input;
        const project = await crud.updateProject(await workspaceOf(ctx), projectId, fields);
        if (!project) throw notFound('Projekt nicht gefunden');
        await ctx.activity?.('project_updated', project.id, `Projekt aktualisiert: ${project.title}`);
        return { project };
    },
});

export const deleteProject = defineAction({
    name: 'workspace_delete_project',
    title: 'Projekt löschen',
    description: 'Löscht ein Projekt endgültig.',
    input: z.object({ id: idSchema }),
    effect: 'destructive',
    target: { kind: 'graph', scope: 'workspace' },
    requires: ['workspace'],
    changes: [OW.Project, OW.Task],
    async run(input, ctx) {
        const workspace = await workspaceOf(ctx);
        const project = await crud.getProject(workspace, input.id);
        const success = await crud.deleteProject(workspace, input.id);
        if (!success) throw notFound('Projekt nicht gefunden');
        if (project) await ctx.activity?.('project_deleted', input.id, `Projekt gelöscht: ${project.title}`);
        return { success: true as const };
    },
});

// ---------------------------------------------------------------------------
// Dokumente
// ---------------------------------------------------------------------------

export const docTypeSchema = z.enum(['TechArticle', 'CreativeWork', 'BlogPosting', 'DefinedTerm', 'HowTo']);

/** Der Slug wird zum Markdown-Dateinamen — strikt pfadsicher. */
export const docSlugSchema = z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Slug darf nur Kleinbuchstaben, Ziffern und Bindestriche enthalten');

export const createDocSchema = z.object({
    title: z.string().min(1, 'Titel ist erforderlich').max(300).describe('Titel des Dokuments'),
    content: z.string().max(2_000_000).default('').describe('Inhalt als Markdown'),
    category: z.string().max(200).optional(),
    tags: z.array(z.string().max(100)).max(100).default([]),
    type: docTypeSchema.optional().describe('schema.org-Typ des Dokuments'),
});

export const updateDocSchema = z.object({
    title: z.string().min(1).max(300).optional(),
    content: z.string().max(2_000_000).optional(),
    category: z.string().max(200).optional(),
    tags: z.array(z.string().max(100)).max(100).optional(),
    type: docTypeSchema.optional(),
    slug: docSlugSchema.optional(),
});

export const listDocs = defineAction({
    name: 'workspace_list_docs',
    title: 'Dokumente auflisten',
    description: 'Listet die Dokumente der Wissensbasis (ohne Inhalt, mit Titel, Kategorie und Tags).',
    input: z.object({
        limit: z.number().int().min(1).max(500).optional().describe('Maximale Anzahl (Default 100)'),
    }),
    effect: 'read',
    target: { kind: 'graph', scope: 'workspace' },
    requires: ['workspace'],
    async run(input, ctx) {
        return { docs: (await crud.listDocs(await workspaceOf(ctx))).slice(0, input.limit ?? 100) };
    },
});

export const getDoc = defineAction({
    name: 'workspace_get_doc',
    title: 'Dokument lesen',
    description: 'Liest ein Dokument mit Inhalt.',
    input: z.object({ id: idSchema.describe('ID des Dokuments') }),
    effect: 'read',
    target: { kind: 'graph', scope: 'workspace' },
    requires: ['workspace'],
    async run(input, ctx) {
        const doc = await crud.getDoc(await workspaceOf(ctx), input.id);
        if (!doc) throw notFound('Dokument nicht gefunden');
        return { doc };
    },
});

export const createDoc = defineAction({
    name: 'workspace_create_doc',
    title: 'Dokument anlegen',
    description: 'Legt ein neues Dokument in der Wissensbasis an.',
    input: createDocSchema,
    effect: 'constructive',
    target: { kind: 'graph', scope: 'workspace' },
    requires: ['workspace'],
    changes: [OW.Document],
    async run(input, ctx) {
        const doc = await crud.createDoc(await workspaceOf(ctx), input);
        await ctx.activity?.('doc_created', doc.id, `Dokument erstellt: ${doc.title}`);
        return { doc };
    },
});

export const updateDoc = defineAction({
    name: 'workspace_update_doc',
    title: 'Dokument ändern',
    description: 'Ändert Titel, Inhalt, Kategorie, Tags oder Typ eines Dokuments.',
    input: updateDocSchema.extend({ docId: idSchema.describe('ID des Dokuments') }),
    effect: 'constructive',
    target: { kind: 'graph', scope: 'workspace' },
    requires: ['workspace'],
    changes: [OW.Document],
    async run(input, ctx) {
        const { docId, ...fields } = input;
        const doc = await crud.updateDoc(await workspaceOf(ctx), docId, fields);
        if (!doc) throw notFound('Dokument nicht gefunden');
        await ctx.activity?.('doc_updated', doc.id, `Dokument bearbeitet: ${doc.title}`);
        return { doc };
    },
});

export const deleteDoc = defineAction({
    name: 'workspace_delete_doc',
    title: 'Dokument löschen',
    description: 'Löscht ein Dokument endgültig.',
    input: z.object({ id: idSchema }),
    effect: 'destructive',
    target: { kind: 'graph', scope: 'workspace' },
    requires: ['workspace'],
    changes: [OW.Document],
    async run(input, ctx) {
        const workspace = await workspaceOf(ctx);
        const doc = await crud.getDoc(workspace, input.id);
        const success = await crud.deleteDoc(workspace, input.id);
        if (!success) throw notFound('Dokument nicht gefunden');
        if (doc) await ctx.activity?.('doc_deleted', input.id, `Dokument gelöscht: ${doc.title}`);
        return { success: true as const };
    },
});

// ---------------------------------------------------------------------------
// Pinnwände
// ---------------------------------------------------------------------------

const canvasCardTypeSchema = z.enum(['note', 'task', 'link', 'image', 'file', 'group']);
const canvasConnectionTypeSchema = z.enum(['simple', 'directional', 'bidirectional']);

const canvasCardUpdatesSchema = z.object({
    type: canvasCardTypeSchema.optional(),
    title: z.string().max(500).optional(),
    content: z.string().max(100_000).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().min(1).max(100_000).optional(),
    height: z.number().min(1).max(100_000).optional(),
    color: z.string().max(50).optional(),
});

const canvasConnectionUpdatesSchema = z.object({
    fromId: z.string().max(200).optional(),
    toId: z.string().max(200).optional(),
    type: canvasConnectionTypeSchema.optional(),
    label: z.string().max(500).optional(),
});

const viewportSchema = z.object({
    x: z.number(),
    y: z.number(),
    zoom: z.number().min(0.01).max(100),
});

const canvasTarget = { kind: 'graph', scope: 'workspace' } as const;

export const listCanvases = defineAction({
    name: 'workspace_list_canvases',
    title: 'Pinnwände auflisten',
    description: 'Listet die Pinnwände (Canvas) mit Kartenzahl.',
    input: z.object({}),
    effect: 'read',
    target: canvasTarget,
    requires: ['workspace'],
    async run(_input, ctx) {
        return { canvases: await crud.listCanvases(await workspaceOf(ctx)) };
    },
});

export const getCanvas = defineAction({
    name: 'workspace_get_canvas',
    title: 'Pinnwand lesen',
    description: 'Liest eine Pinnwand mit Karten und Verbindungen.',
    input: z.object({ id: idSchema.describe('ID der Pinnwand') }),
    effect: 'read',
    target: canvasTarget,
    requires: ['workspace'],
    async run(input, ctx) {
        const canvas = await crud.getCanvas(await workspaceOf(ctx), input.id);
        if (!canvas) throw notFound('Canvas nicht gefunden');
        return { canvas };
    },
});

export const createCanvas = defineAction({
    name: 'workspace_create_canvas',
    title: 'Pinnwand anlegen',
    description: 'Legt eine neue, leere Pinnwand an.',
    input: z.object({
        name: z.string().min(1, 'Name ist erforderlich').max(300),
        description: z.string().max(2_000).optional(),
    }),
    effect: 'constructive',
    target: canvasTarget,
    requires: ['workspace'],
    changes: [OW.Canvas],
    async run(input, ctx) {
        const canvas = await crud.createCanvas(await workspaceOf(ctx), input.name, input.description);
        await ctx.activity?.('canvas_created', canvas.id, `Canvas erstellt: ${canvas.name}`);
        return { canvas };
    },
});

/**
 * Import einer `.canvas`-Datei (JSON Canvas 1.0, SPEC §9 / M5).
 * Fehlertolerant: ungültige Einträge werden übersprungen und gemeldet;
 * nur eine komplett leere Quelle ist ein Fehler.
 */
export const importCanvas = defineAction({
    name: 'workspace_import_canvas',
    title: 'Pinnwand importieren',
    description: 'Importiert eine JSON-Canvas-Datei (Obsidian Canvas 1.0) als neue Pinnwand.',
    input: z.object({
        name: z.string().min(1, 'Name ist erforderlich').max(300),
        json: z.string().min(1, 'Dateiinhalt fehlt').max(5_000_000).describe('Inhalt der .canvas-Datei'),
    }),
    effect: 'constructive',
    target: canvasTarget,
    requires: ['workspace'],
    changes: [OW.Canvas],
    async run(input, ctx) {
        const parsed = parseJsonCanvas(input.json, `${input.name}.canvas`);
        const skipped = parsed.issues.map(issue => `${issue.source}: ${issue.reason}`);
        if (parsed.canvas.nodes.length === 0 && parsed.issues.length > 0) {
            throw new ActionError(400, 'Datei konnte nicht als JSON Canvas 1.0 gelesen werden', skipped);
        }
        const native = jsonCanvasToNative(parsed.canvas);
        const canvas = await crud.importCanvas(await workspaceOf(ctx), {
            name: input.name,
            cards: native.cards,
            connections: native.connections,
        });
        await ctx.activity?.('canvas_created', canvas.id, `Canvas importiert: ${canvas.name}`);
        return { canvas, skipped };
    },
});

export const updateCanvas = defineAction({
    name: 'workspace_update_canvas',
    title: 'Pinnwand umbenennen',
    description: 'Ändert Name oder Beschreibung einer Pinnwand.',
    input: z.object({
        canvasId: idSchema,
        name: z.string().min(1).max(300).optional(),
        description: z.string().max(2_000).optional(),
    }),
    effect: 'constructive',
    target: canvasTarget,
    requires: ['workspace'],
    changes: [OW.Canvas],
    async run(input, ctx) {
        const canvas = await crud.updateCanvasMeta(await workspaceOf(ctx), input.canvasId, {
            name: input.name,
            description: input.description,
        });
        if (!canvas) throw notFound('Canvas nicht gefunden');
        await ctx.activity?.('canvas_updated', canvas.id, `Canvas bearbeitet: ${canvas.name}`);
        return { canvas };
    },
});

export const deleteCanvas = defineAction({
    name: 'workspace_delete_canvas',
    title: 'Pinnwand löschen',
    description: 'Löscht eine Pinnwand mit allen Karten.',
    input: z.object({ id: idSchema }),
    effect: 'destructive',
    target: canvasTarget,
    requires: ['workspace'],
    changes: [OW.Canvas],
    async run(input, ctx) {
        const workspace = await workspaceOf(ctx);
        const canvas = await crud.getCanvas(workspace, input.id);
        const success = await crud.deleteCanvas(workspace, input.id);
        if (!success) throw notFound('Canvas nicht gefunden');
        if (canvas) await ctx.activity?.('canvas_deleted', input.id, `Canvas gelöscht: ${canvas.name}`);
        return { success: true as const };
    },
});

export const createCard = defineAction({
    name: 'workspace_create_card',
    title: 'Karte anlegen',
    description: 'Legt eine Karte auf einer Pinnwand an (Notiz, Aufgabe, Link, Bild, Datei oder Gruppe).',
    input: z.object({
        canvasId: idSchema.describe('ID der Pinnwand (aus workspace_list_canvases)'),
        type: canvasCardTypeSchema.optional(),
        title: z.string().max(500).optional(),
        content: z.string().max(100_000).optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().min(1).max(100_000).optional(),
        height: z.number().min(1).max(100_000).optional(),
        color: z.string().max(50).optional(),
    }),
    effect: 'constructive',
    target: canvasTarget,
    requires: ['workspace'],
    changes: [OW.Canvas],
    async run(input, ctx) {
        const card = await crud.createCard(await workspaceOf(ctx), input.canvasId, {
            type: input.type,
            title: input.title || 'Neue Karte',
            content: input.content,
            x: input.x ?? 100,
            y: input.y ?? 100,
            width: input.width,
            height: input.height,
            color: input.color,
        });
        if (!card) throw notFound('Canvas nicht gefunden');
        await ctx.activity?.('canvas_updated', input.canvasId, `Canvas Karte erstellt: ${card.title}`);
        return { card };
    },
});

export const updateCard = defineAction({
    name: 'workspace_update_card',
    title: 'Karte ändern',
    description: 'Ändert Inhalt, Position oder Größe einer Karte.',
    input: z.object({ canvasId: idSchema, cardId: idSchema, updates: canvasCardUpdatesSchema }),
    effect: 'constructive',
    target: canvasTarget,
    requires: ['workspace'],
    changes: [OW.Canvas],
    async run(input, ctx) {
        const card = await crud.updateCard(await workspaceOf(ctx), input.canvasId, input.cardId, input.updates);
        if (!card) throw notFound('Karte nicht gefunden');
        // Kein Aktivitätslog: Positionsänderungen kommen hochfrequent.
        return { card };
    },
});

export const deleteCard = defineAction({
    name: 'workspace_delete_card',
    title: 'Karte löschen',
    description: 'Entfernt eine Karte von der Pinnwand.',
    input: z.object({ canvasId: idSchema, cardId: idSchema }),
    effect: 'destructive',
    target: canvasTarget,
    requires: ['workspace'],
    changes: [OW.Canvas],
    async run(input, ctx) {
        const success = await crud.deleteCard(await workspaceOf(ctx), input.canvasId, input.cardId);
        if (!success) throw notFound('Karte nicht gefunden');
        await ctx.activity?.('canvas_updated', input.canvasId, 'Canvas Karte gelöscht');
        return { success: true as const };
    },
});

export const createConnection = defineAction({
    name: 'workspace_create_connection',
    title: 'Karten verbinden',
    description: 'Verbindet zwei Karten einer Pinnwand.',
    input: z.object({
        canvasId: idSchema,
        fromId: idSchema,
        toId: idSchema,
        type: canvasConnectionTypeSchema.optional(),
        label: z.string().max(500).optional(),
    }),
    effect: 'constructive',
    target: canvasTarget,
    requires: ['workspace'],
    changes: [OW.Canvas],
    async run(input, ctx) {
        const connection = await crud.createConnection(
            await workspaceOf(ctx),
            input.canvasId,
            input.fromId,
            input.toId,
            input.type || 'directional',
            input.label,
        );
        if (!connection) throw notFound('Karten nicht gefunden');
        return { connection };
    },
});

export const updateConnection = defineAction({
    name: 'workspace_update_connection',
    title: 'Verbindung ändern',
    description: 'Ändert Richtung, Art oder Beschriftung einer Verbindung.',
    input: z.object({ canvasId: idSchema, connectionId: idSchema, updates: canvasConnectionUpdatesSchema }),
    effect: 'constructive',
    target: canvasTarget,
    requires: ['workspace'],
    changes: [OW.Canvas],
    async run(input, ctx) {
        const connection = await crud.updateConnection(await workspaceOf(ctx), input.canvasId, input.connectionId, input.updates);
        if (!connection) throw notFound('Verbindung nicht gefunden');
        return { connection };
    },
});

export const deleteConnection = defineAction({
    name: 'workspace_delete_connection',
    title: 'Verbindung löschen',
    description: 'Entfernt eine Verbindung zwischen zwei Karten.',
    input: z.object({ canvasId: idSchema, connectionId: idSchema }),
    effect: 'destructive',
    target: canvasTarget,
    requires: ['workspace'],
    changes: [OW.Canvas],
    async run(input, ctx) {
        const success = await crud.deleteConnection(await workspaceOf(ctx), input.canvasId, input.connectionId);
        if (!success) throw notFound('Verbindung nicht gefunden');
        return { success: true as const };
    },
});

export const setViewport = defineAction({
    name: 'workspace_set_viewport',
    title: 'Ansicht speichern',
    description: 'Speichert den sichtbaren Ausschnitt (Position und Zoom) einer Pinnwand.',
    input: z.object({ canvasId: idSchema, viewport: viewportSchema }),
    effect: 'constructive',
    target: canvasTarget,
    requires: ['workspace'],
    changes: [OW.Canvas],
    async run(input, ctx) {
        await crud.updateViewport(await workspaceOf(ctx), input.canvasId, input.viewport);
        return { success: true as const };
    },
});

/**
 * Die Pinnwand-Route ist aktionsbasiert (`{ action: 'createCard', … }`):
 * Der Diskriminator wählt die Aktion, der Rest ist ihre Eingabe.
 */
export const CANVAS_ACTIONS_BY_KIND = {
    create: createCanvas,
    import: importCanvas,
    updateMeta: updateCanvas,
    delete: deleteCanvas,
    createCard,
    updateCard,
    deleteCard,
    createConnection,
    updateConnection,
    deleteConnection,
    updateViewport: setViewport,
} as const;

registerActions('graph/workspace', [
    listTasks, getTask, createTask, updateTask, deleteTask,
    listProjects, getProject, createProject, updateProject, deleteProject,
    listDocs, getDoc, createDoc, updateDoc, deleteDoc,
    listCanvases, getCanvas, createCanvas, importCanvas, updateCanvas, deleteCanvas,
    createCard, updateCard, deleteCard, createConnection, updateConnection, deleteConnection, setViewport,
]);

// ---------------------------------------------------------------------------
// Kalender (M15: schema:DataFeed + schema:Event im Workspace-Graphen)
// ---------------------------------------------------------------------------

const calendarProviderUpdatesSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    url: httpUrlSchema.optional(),
    color: z.string().max(50).optional(),
    enabled: z.boolean().optional(),
});

export const listCalendars = defineAction({
    name: 'calendar_list_providers',
    title: 'Kalender auflisten',
    description: 'Listet die abonnierten Kalender (ICS-Quellen) mit Farbe und letztem Abruf.',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'graph', scope: 'workspace' },
    requires: ['workspace'],
    async run(_input, ctx) {
        return { providers: await crud.listCalendars(await workspaceOf(ctx)) };
    },
});

export const listEvents = defineAction({
    name: 'calendar_list_events',
    title: 'Termine auflisten',
    description: 'Listet Termine der abonnierten Kalender, optional in einem Zeitfenster (ISO-Zeitpunkte).',
    input: z.object({
        start: z.string().max(40).optional().describe('Beginn des Fensters (ISO)'),
        end: z.string().max(40).optional().describe('Ende des Fensters (ISO)'),
        limit: z.number().int().min(1).max(1000).optional().describe('Maximale Anzahl (Default 200)'),
    }),
    effect: 'read',
    target: { kind: 'graph', scope: 'workspace' },
    requires: ['workspace'],
    async run(input, ctx) {
        const events = await crud.listEvents(await workspaceOf(ctx), { start: input.start, end: input.end });
        return { events: events.slice(0, input.limit ?? 200) };
    },
});

export const addCalendar = defineAction({
    name: 'calendar_add_provider',
    title: 'Kalender abonnieren',
    description: 'Abonniert einen ICS-Kalender (URL) und ruft ihn sofort ab.',
    input: z.object({
        name: z.string().min(1, 'Name ist erforderlich').max(200),
        url: httpUrlSchema,
        color: z.string().max(50).default('#00674F'),
    }),
    effect: 'constructive',
    target: { kind: 'graph', scope: 'workspace' },
    requires: ['workspace'],
    changes: [SCHEMA.DataFeed, SCHEMA.Event],
    async run(input, ctx) {
        const workspace = await workspaceOf(ctx);
        const provider = await crud.createCalendar(workspace, { name: input.name, url: input.url, color: input.color });
        // Sofort abrufen — ein leerer Kalender direkt nach dem Anlegen sähe
        // aus wie ein kaputter. Scheitert der Abruf, bleibt das Abonnement
        // bestehen und meldet es beim nächsten Sync.
        try {
            await syncCalendar(workspace, provider.id);
        } catch (error) {
            console.error(`Failed to initial sync provider ${input.name}:`, error);
        }
        return { provider };
    },
});

export const updateCalendar = defineAction({
    name: 'calendar_update_provider',
    title: 'Kalender ändern',
    description: 'Ändert Name, URL, Farbe oder Aktivierung eines abonnierten Kalenders.',
    input: z.object({ id: idSchema, updates: calendarProviderUpdatesSchema }),
    effect: 'constructive',
    target: { kind: 'graph', scope: 'workspace' },
    requires: ['workspace'],
    changes: [SCHEMA.DataFeed],
    async run(input, ctx) {
        const provider = await crud.updateCalendar(await workspaceOf(ctx), input.id, input.updates);
        if (!provider) throw notFound('Provider nicht gefunden');
        return { provider };
    },
});

export const deleteCalendar = defineAction({
    name: 'calendar_delete_provider',
    title: 'Kalender entfernen',
    description: 'Entfernt ein Kalender-Abonnement samt seiner Termine.',
    input: z.object({ id: idSchema }),
    effect: 'destructive',
    target: { kind: 'graph', scope: 'workspace' },
    requires: ['workspace'],
    changes: [SCHEMA.DataFeed, SCHEMA.Event],
    async run(input, ctx) {
        const success = await crud.deleteCalendar(await workspaceOf(ctx), input.id);
        if (!success) throw notFound('Provider nicht gefunden');
        return { success: true as const };
    },
});

export const syncCalendarAction = defineAction({
    name: 'calendar_sync_provider',
    title: 'Kalender abrufen',
    description: 'Ruft einen abonnierten Kalender neu ab und ersetzt seine Termine.',
    input: z.object({ id: idSchema }),
    effect: 'constructive',
    target: { kind: 'graph', scope: 'workspace' },
    requires: ['workspace'],
    changes: [SCHEMA.Event],
    async run(input, ctx) {
        const count = await syncCalendar(await workspaceOf(ctx), input.id);
        return { success: true as const, count };
    },
});

export const CALENDAR_ACTIONS_BY_KIND = {
    addProvider: addCalendar,
    updateProvider: updateCalendar,
    deleteProvider: deleteCalendar,
    syncProvider: syncCalendarAction,
} as const;

// ---------------------------------------------------------------------------
// Unterhaltungen des Assistenten (M15: schema:Conversation + schema:Message)
// ---------------------------------------------------------------------------

const conversationTarget = { kind: 'graph', scope: 'workspace' } as const;

export const listConversations = defineAction({
    name: 'chat_list_conversations',
    title: 'Unterhaltungen auflisten',
    description: 'Listet die gespeicherten Unterhaltungen des Assistenten und die zuletzt geöffnete.',
    input: z.object({}),
    effect: 'read',
    target: conversationTarget,
    requires: ['workspace'],
    async run(_input, ctx) {
        const workspace = await workspaceOf(ctx);
        return {
            conversations: await crud.listConversations(workspace),
            activeId: await crud.getActiveConversationId(workspace),
        };
    },
});

export const getConversation = defineAction({
    name: 'chat_get_conversation',
    title: 'Unterhaltung lesen',
    description: 'Liest eine Unterhaltung mit allen Nachrichten.',
    input: z.object({ id: idSchema }),
    effect: 'read',
    target: conversationTarget,
    requires: ['workspace'],
    async run(input, ctx) {
        const conversation = await crud.getConversation(await workspaceOf(ctx), input.id);
        if (!conversation) throw notFound('Konversation nicht gefunden');
        return { conversation };
    },
});

export const createConversation = defineAction({
    name: 'chat_create_conversation',
    title: 'Unterhaltung anlegen',
    description: 'Legt eine neue Unterhaltung an.',
    input: z.object({ title: z.string().max(300).optional() }),
    effect: 'constructive',
    target: conversationTarget,
    requires: ['workspace'],
    changes: [SCHEMA.Conversation],
    async run(input, ctx) {
        return { conversation: await crud.createConversation(await workspaceOf(ctx), input.title) };
    },
});

export const addMessage = defineAction({
    name: 'chat_add_message',
    title: 'Nachricht anhängen',
    description: 'Hängt eine Nachricht (Nutzer oder Assistent) an eine Unterhaltung an, optional mit A2UI-Oberfläche.',
    input: z.object({
        conversationId: idSchema,
        role: z.enum(['user', 'assistant']),
        content: z.string().max(500_000),
        uiComponents: z.array(z.unknown()).max(500).optional(),
    }),
    effect: 'constructive',
    target: conversationTarget,
    requires: ['workspace'],
    changes: [SCHEMA.Message],
    async run(input, ctx) {
        const message = await crud.addMessage(await workspaceOf(ctx), input.conversationId, input.role, input.content, input.uiComponents);
        if (!message) throw notFound('Konversation nicht gefunden');
        return { message };
    },
});

export const updateMessage = defineAction({
    name: 'chat_update_message',
    title: 'Nachricht ändern',
    description: 'Ersetzt den Text einer Nachricht.',
    input: z.object({ conversationId: idSchema, messageId: idSchema, content: z.string().max(500_000) }),
    effect: 'constructive',
    target: conversationTarget,
    requires: ['workspace'],
    changes: [SCHEMA.Message],
    async run(input, ctx) {
        const message = await crud.updateMessage(await workspaceOf(ctx), input.conversationId, input.messageId, input.content);
        if (!message) throw notFound('Nachricht nicht gefunden');
        return { message };
    },
});

export const renameConversation = defineAction({
    name: 'chat_rename_conversation',
    title: 'Unterhaltung umbenennen',
    description: 'Gibt einer Unterhaltung einen neuen Titel.',
    input: z.object({ id: idSchema, title: z.string().min(1).max(300) }),
    effect: 'constructive',
    target: conversationTarget,
    requires: ['workspace'],
    changes: [SCHEMA.Conversation],
    async run(input, ctx) {
        const conversation = await crud.renameConversation(await workspaceOf(ctx), input.id, input.title);
        if (!conversation) throw notFound('Konversation nicht gefunden');
        return { conversation };
    },
});

export const deleteConversation = defineAction({
    name: 'chat_delete_conversation',
    title: 'Unterhaltung löschen',
    description: 'Löscht eine Unterhaltung mit allen Nachrichten.',
    input: z.object({ id: idSchema }),
    effect: 'destructive',
    target: conversationTarget,
    requires: ['workspace'],
    changes: [SCHEMA.Conversation, SCHEMA.Message],
    async run(input, ctx) {
        const success = await crud.deleteConversation(await workspaceOf(ctx), input.id);
        if (!success) throw notFound('Konversation nicht gefunden');
        return { success: true as const };
    },
});

export const setActiveConversation = defineAction({
    name: 'chat_set_active',
    title: 'Unterhaltung auswählen',
    description: 'Merkt sich, welche Unterhaltung die Oberfläche als Nächstes öffnet.',
    input: z.object({ id: idSchema }),
    effect: 'constructive',
    target: conversationTarget,
    requires: ['workspace'],
    changes: [SCHEMA.Conversation],
    async run(input, ctx) {
        await crud.setActiveConversation(await workspaceOf(ctx), input.id);
        return { success: true as const };
    },
});

export const clearConversations = defineAction({
    name: 'chat_clear_conversations',
    title: 'Alle Unterhaltungen löschen',
    description: 'Löscht sämtliche Unterhaltungen.',
    input: z.object({}),
    effect: 'destructive',
    target: conversationTarget,
    requires: ['workspace'],
    changes: [SCHEMA.Conversation, SCHEMA.Message],
    async run(_input, ctx) {
        await crud.clearConversations(await workspaceOf(ctx));
        return { success: true as const };
    },
});

/** Die Konversations-Route ist aktionsbasiert (`{ action: 'addMessage', … }`). */
export const CONVERSATION_ACTIONS_BY_KIND = {
    create: createConversation,
    addMessage,
    updateMessage,
    rename: renameConversation,
    delete: deleteConversation,
    setActive: setActiveConversation,
    clearAll: clearConversations,
} as const;

registerActions('graph/workspace', [
    listCalendars, listEvents, addCalendar, updateCalendar, deleteCalendar, syncCalendarAction,
    listConversations, getConversation, createConversation, addMessage, updateMessage,
    renameConversation, deleteConversation, setActiveConversation, clearConversations,
]);
