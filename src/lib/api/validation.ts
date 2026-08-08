/**
 * Central request-body validation for the JSON API routes.
 *
 * Every schema mirrors the real storage types (see src/lib/storage/*,
 * src/lib/agents/types.ts, src/lib/tools/types.ts, src/lib/connections/types.ts).
 * Unknown keys are stripped (zod object default), which also prevents clients
 * from overwriting server-managed fields like `id`, `createdAt` or `updatedAt`
 * via spread-updates in the storage layer.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

export type ParsedBody<T> =
    | { ok: true; data: T }
    | { ok: false; response: NextResponse };

function formatIssues(error: z.ZodError): Array<{ path: string; message: string }> {
    return error.issues.map(issue => ({
        path: issue.path.map(String).join('.') || '(root)',
        message: issue.message,
    }));
}

/**
 * Parse and validate a JSON request body against a schema.
 * On failure returns a ready-to-send 400 NextResponse with `{error, details}`.
 */
export async function parseBody<S extends z.ZodType>(
    schema: S,
    request: Request
): Promise<ParsedBody<z.output<S>>> {
    let raw: unknown;
    try {
        raw = await request.json();
    } catch {
        return {
            ok: false,
            response: NextResponse.json(
                { error: 'Ungültiger JSON-Body', details: [] },
                { status: 400 }
            ),
        };
    }

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
        return {
            ok: false,
            response: NextResponse.json(
                { error: 'Validierung fehlgeschlagen', details: formatIssues(parsed.error) },
                { status: 400 }
            ),
        };
    }

    return { ok: true, data: parsed.data };
}

/** String that must be a syntactically valid http(s) URL. */
export const httpUrlSchema = z
    .string()
    .max(2048)
    .refine(value => {
        try {
            const url = new URL(value);
            return url.protocol === 'http:' || url.protocol === 'https:';
        } catch {
            return false;
        }
    }, 'Muss eine gültige http(s)-URL sein');

/** ISO-ish date string; empty string allowed (frontend sends '' for cleared dates). */
const dateStringSchema = z
    .string()
    .max(40)
    .refine(value => value === '' || !Number.isNaN(Date.parse(value)), 'Ungültiges Datum');

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const taskStatusSchema = z.enum(['backlog', 'todo', 'in-progress', 'review', 'done', 'on-hold']);
export const taskPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent']);
export const taskTypeSchema = z.enum(['task', 'bug', 'feature', 'milestone']);

const taskDependencySchema = z.object({
    id: z.string().min(1).max(200),
    type: z.enum(['FS', 'SS', 'FF', 'SF']),
});

export const createTaskSchema = z.object({
    title: z.string().min(1, 'Titel ist erforderlich').max(500),
    description: z.string().max(50_000).optional(),
    status: taskStatusSchema.optional(),
    priority: taskPrioritySchema.optional(),
    type: taskTypeSchema.optional(),
    startDate: dateStringSchema.optional(),
    dueDate: dateStringSchema.optional(),
    deferredUntil: dateStringSchema.optional(),
    estimatedEffort: z.number().min(0).max(100_000).optional(),
    projectId: z.string().max(200).optional(),
    tags: z.array(z.string().max(100)).max(100).optional(),
    dependencies: z.array(taskDependencySchema).max(100).optional(),
});

export const updateTaskSchema = createTaskSchema
    .partial()
    .extend({
        actualEffort: z.number().min(0).max(100_000).optional(),
    });

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const projectStatusSchema = z.enum(['planning', 'active', 'completed', 'archived']);

export const createProjectSchema = z.object({
    title: z.string().min(1, 'Titel ist erforderlich').max(300),
    description: z.string().max(10_000).optional(),
    prefix: z.string().min(1, 'Präfix ist erforderlich').max(20),
    status: projectStatusSchema.optional(),
    color: z.string().max(50).optional(),
});

export const updateProjectSchema = createProjectSchema.partial();

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export const agentConfigSchema = z.object({
    systemPrompt: z.string().max(50_000).optional(),
    model: z.string().max(200).optional(),
});

export const createAgentSchema = z.object({
    name: z.string().min(1, 'Name ist erforderlich').max(200),
    description: z.string().max(2_000).default(''),
    type: z.enum(['local', 'remote_a2a']),
    connectionId: z.string().max(200).optional(),
    config: agentConfigSchema.default({}),
});

export const updateAgentSchema = z.object({
    id: z.string().min(1, 'id ist erforderlich').max(200),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2_000).optional(),
    type: z.enum(['local', 'remote_a2a']).optional(),
    connectionId: z.string().max(200).nullable().optional(),
    config: agentConfigSchema.optional(),
    enabled: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const toolConfigSchema = z.object({
    url: z.string().max(2048).optional(),
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).optional(),
    headers: z.record(z.string().max(200), z.string().max(4096)).optional(),
    body: z.string().max(100_000).optional(),
});

export const createToolSchema = z.object({
    name: z.string().min(1, 'Name ist erforderlich').max(200),
    description: z.string().max(2_000).default(''),
    type: z.enum(['api', 'mcp']),
    connectionId: z.string().max(200).optional(),
    config: toolConfigSchema.default({}),
});

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export const authConfigSchema = z.object({
    type: z.enum(['bearer', 'basic', 'apikey', 'none']),
    token: z.string().max(10_000).optional(),
    username: z.string().max(500).optional(),
    password: z.string().max(10_000).optional(),
    apiKey: z.string().max(10_000).optional(),
    headerName: z.string().max(200).optional(),
});

export const createConnectionSchema = z.object({
    name: z.string().min(1, 'Name ist erforderlich').max(200),
    description: z.string().max(2_000).optional(),
    type: z.enum(['rest', 'mcp', 'oauth']),
    baseUrl: z.string().max(2048).optional(),
    auth: authConfigSchema.default({ type: 'none' }),
});

export const updateConnectionSchema = z.object({
    id: z.string().min(1, 'id ist erforderlich').max(200),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2_000).optional(),
    baseUrl: z.string().max(2048).optional(),
    auth: authConfigSchema.optional(),
});

// ---------------------------------------------------------------------------
// Docs
// ---------------------------------------------------------------------------

export const docTypeSchema = z.enum(['TechArticle', 'CreativeWork', 'BlogPosting', 'DefinedTerm', 'HowTo']);

/** Slug becomes the markdown filename – keep it strictly path-safe. */
export const docSlugSchema = z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Slug darf nur Kleinbuchstaben, Ziffern und Bindestriche enthalten');

export const createDocSchema = z.object({
    title: z.string().min(1, 'Titel ist erforderlich').max(300),
    content: z.string().max(2_000_000).default(''),
    category: z.string().max(200).optional(),
    tags: z.array(z.string().max(100)).max(100).default([]),
    type: docTypeSchema.optional(),
});

export const updateDocSchema = z.object({
    title: z.string().min(1).max(300).optional(),
    content: z.string().max(2_000_000).optional(),
    category: z.string().max(200).optional(),
    tags: z.array(z.string().max(100)).max(100).optional(),
    type: docTypeSchema.optional(),
    slug: docSlugSchema.optional(),
});

// ---------------------------------------------------------------------------
// Canvas (action-based endpoint)
// ---------------------------------------------------------------------------

const canvasCardTypeSchema = z.enum(['note', 'task', 'link', 'image']);
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

export const canvasActionSchema = z.discriminatedUnion('action', [
    z.object({
        action: z.literal('create'),
        name: z.string().min(1, 'Name ist erforderlich').max(300),
        description: z.string().max(2_000).optional(),
    }),
    z.object({
        action: z.literal('updateMeta'),
        canvasId: z.string().min(1).max(200),
        name: z.string().min(1).max(300).optional(),
        description: z.string().max(2_000).optional(),
    }),
    z.object({
        action: z.literal('delete'),
        id: z.string().min(1).max(200),
    }),
    z.object({
        action: z.literal('createCard'),
        canvasId: z.string().min(1).max(200),
        type: canvasCardTypeSchema.optional(),
        title: z.string().max(500).optional(),
        content: z.string().max(100_000).optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().min(1).max(100_000).optional(),
        height: z.number().min(1).max(100_000).optional(),
        color: z.string().max(50).optional(),
    }),
    z.object({
        action: z.literal('updateCard'),
        canvasId: z.string().min(1).max(200),
        cardId: z.string().min(1).max(200),
        updates: canvasCardUpdatesSchema,
    }),
    z.object({
        action: z.literal('deleteCard'),
        canvasId: z.string().min(1).max(200),
        cardId: z.string().min(1).max(200),
    }),
    z.object({
        action: z.literal('createConnection'),
        canvasId: z.string().min(1).max(200),
        fromId: z.string().min(1).max(200),
        toId: z.string().min(1).max(200),
        type: canvasConnectionTypeSchema.optional(),
        label: z.string().max(500).optional(),
    }),
    z.object({
        action: z.literal('updateConnection'),
        canvasId: z.string().min(1).max(200),
        connectionId: z.string().min(1).max(200),
        updates: canvasConnectionUpdatesSchema,
    }),
    z.object({
        action: z.literal('deleteConnection'),
        canvasId: z.string().min(1).max(200),
        connectionId: z.string().min(1).max(200),
    }),
    z.object({
        action: z.literal('updateViewport'),
        canvasId: z.string().min(1).max(200),
        viewport: viewportSchema,
    }),
]);

// ---------------------------------------------------------------------------
// Dashboard layout
// ---------------------------------------------------------------------------

export const dashboardWidgetSchema = z.object({
    id: z.string().min(1).max(200),
    type: z.enum(['welcome', 'stats', 'activity', 'image', 'quick-access']),
    order: z.number().int().min(0).max(10_000),
    content: z.string().max(50_000).optional(),
    url: z.string().max(2048).optional(),
    title: z.string().max(300).optional(),
});

export const dashboardLayoutSchema = z.object({
    layout: z.array(dashboardWidgetSchema).max(100),
});

// ---------------------------------------------------------------------------
// Calendar (action-based endpoint)
// ---------------------------------------------------------------------------

const calendarProviderUpdatesSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    url: httpUrlSchema.optional(),
    color: z.string().max(50).optional(),
    enabled: z.boolean().optional(),
});

export const calendarActionSchema = z.discriminatedUnion('action', [
    z.object({
        action: z.literal('addProvider'),
        name: z.string().min(1, 'Name ist erforderlich').max(200),
        url: httpUrlSchema,
        color: z.string().max(50).default('#00674F'),
    }),
    z.object({
        action: z.literal('updateProvider'),
        id: z.string().min(1).max(200),
        updates: calendarProviderUpdatesSchema,
    }),
    z.object({
        action: z.literal('deleteProvider'),
        id: z.string().min(1).max(200),
    }),
    z.object({
        action: z.literal('syncProvider'),
        id: z.string().min(1).max(200),
    }),
]);
