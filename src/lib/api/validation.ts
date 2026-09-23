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
import { ShaclViolationError } from '@/lib/graph/reasoning/shacl';

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

/**
 * SHACL-Blockade (GRAPH_CORE_SPEC §7.2, M7): Der Store-first-Schreibpfad
 * lehnt Mutationen ab, die NEUE sh:Violation-Verstöße einführen. Diese
 * Helper-Funktion übersetzt den Fehler in eine 422-Antwort mit dem
 * vollständigen Befund; für alle anderen Fehler liefert sie null und der
 * Route-eigene Catch greift wie bisher.
 */
export function shaclErrorResponse(error: unknown): NextResponse | null {
    if (error instanceof ShaclViolationError) {
        return NextResponse.json(
            {
                error: 'Änderung verletzt die Datenqualitäts-Regeln (SHACL)',
                details: error.message,
                violations: error.violations,
            },
            { status: 422 },
        );
    }
    return null;
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

// ---------------------------------------------------------------------------
// Aufgaben, Projekte, Dokumente, Pinnwände: seit A1 Teil ihrer Aktionen
// (src/lib/graph/workspace/actions.ts) — das Schema gehört zur Fähigkeit,
// nicht zur Route (ACTIONS_SPEC §2).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export const agentConfigSchema = z.object({
    systemPrompt: z.string().max(50_000).optional(),
    model: z.string().max(200).optional(),
    providerId: z.string().max(200).optional(),
    endpointUrl: z.string().max(2048).optional(),
    cardUrl: z.string().max(2048).optional(),
    capabilities: z.array(z.string().max(500)).max(100).optional(),
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
// AI platform (providers, defaults, MCP servers)
// ---------------------------------------------------------------------------

export const providerKindSchema = z.enum([
    'ollama', 'lmstudio', 'llamacpp', 'vllm', 'jan', 'webllm',
    'openai', 'anthropic', 'google', 'mistral', 'groq', 'openrouter',
    'together', 'deepseek', 'xai', 'custom',
]);

export const connectionModeSchema = z.enum(['auto', 'browser', 'server']);
export const keyLocationSchema = z.enum(['none', 'server', 'browser']);
export const toolCallModeSchema = z.enum(['auto', 'native', 'text']);

export const createProviderSchema = z.object({
    label: z.string().min(1, 'Name ist erforderlich').max(200),
    kind: providerKindSchema,
    baseUrl: z.string().max(2048).default(''),
    connectionMode: connectionModeSchema.default('auto'),
    keyLocation: keyLocationSchema.default('none'),
    apiKey: z.string().max(10_000).optional(),
    defaultModel: z.string().max(300).optional(),
    pinnedModels: z.array(z.string().max(300)).max(200).optional(),
    toolCalls: toolCallModeSchema.default('auto'),
    enabled: z.boolean().default(true),
});

export const updateProviderSchema = createProviderSchema.partial();

export const aiDefaultsSchema = z.object({
    providerId: z.string().max(200).optional(),
    model: z.string().max(300).optional(),
});

export const mcpTransportSchema = z.enum(['auto', 'streamable-http', 'sse']);

export const createMcpServerSchema = z.object({
    label: z.string().min(1, 'Name ist erforderlich').max(200),
    url: httpUrlSchema,
    transport: mcpTransportSchema.default('auto'),
    connectionMode: connectionModeSchema.default('auto'),
    authHeaderName: z.string().max(200).optional(),
    authHeaderValue: z.string().max(10_000).optional(),
    enabled: z.boolean().default(true),
});

export const updateMcpServerSchema = createMcpServerSchema.partial();

/** Ops relayed to a configured MCP server (server-side execution). */
export const mcpOpSchema = z.discriminatedUnion('op', [
    z.object({ op: z.literal('probe') }),
    z.object({ op: z.literal('listTools') }),
    z.object({
        op: z.literal('callTool'),
        name: z.string().min(1).max(200),
        args: z.record(z.string(), z.unknown()).default({}),
    }),
    z.object({ op: z.literal('listPrompts') }),
    z.object({
        op: z.literal('getPrompt'),
        name: z.string().min(1).max(200),
        args: z.record(z.string(), z.string().max(10_000)).optional(),
    }),
]);

/** Ops relayed to A2A agents (server-side execution). */
export const a2aOpSchema = z.discriminatedUnion('op', [
    z.object({ op: z.literal('discover'), url: httpUrlSchema }),
    z.object({
        op: z.literal('send'),
        agentId: z.string().min(1).max(200),
        prompt: z.string().min(1).max(100_000),
    }),
]);

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export const skillSourceSchema = z.object({
    type: z.enum(['manual', 'url', 'repo', 'mcp-prompt']),
    ref: z.string().max(2048).optional(),
});

export const createSkillSchema = z.object({
    name: z.string().min(1, 'Name ist erforderlich').max(300),
    description: z.string().max(2_000).default(''),
    content: z.string().max(500_000),
    source: skillSourceSchema.default({ type: 'manual' }),
    enabled: z.boolean().default(true),
    alwaysInject: z.boolean().default(false),
});

export const updateSkillSchema = createSkillSchema.partial();

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
