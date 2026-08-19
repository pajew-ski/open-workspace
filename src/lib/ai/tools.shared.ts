import type { Tool } from '@/lib/tools/types';
import type { SkillMeta } from '@/lib/skills/types';
import type { EngineTool, EngineToolResult } from './engine';
import type { PromptToolInfo } from './prompt';
import type { McpToolDescriptor, McpCallOutcome } from './mcp/client';

/**
 * Builders that turn the workspace's tool sources — built-ins, user
 * configured API tools, MCP server tools, skills — into uniform
 * EngineTools. Shared by the server route and the browser engine; only
 * the `execute` implementations differ per context.
 */

/** Extract {placeholder} names from an API tool's URL/body templates. */
export function extractPlaceholders(tool: Tool): string[] {
    const sources = [tool.config.url ?? '', tool.config.body ?? ''];
    const names = new Set<string>();
    for (const source of sources) {
        for (const match of source.matchAll(/\{([a-zA-Z0-9_.-]+)\}/g)) {
            names.add(match[1]);
        }
    }
    return [...names];
}

function schemaFromPlaceholders(placeholders: string[]): Record<string, unknown> {
    if (placeholders.length === 0) {
        return { type: 'object', properties: {}, additionalProperties: true };
    }
    const properties: Record<string, unknown> = {};
    for (const name of placeholders) {
        properties[name] = { type: 'string', description: `Wert für Platzhalter {${name}}` };
    }
    return { type: 'object', properties, required: placeholders, additionalProperties: false };
}

/** Safe native-calling name for a tool (OpenAI: ^[a-zA-Z0-9_-]{1,64}$). */
export function safeToolName(raw: string): string {
    const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    return cleaned || 'tool';
}

export function apiToolToEngineTool(
    tool: Tool,
    execute: (tool: Tool, args: Record<string, unknown>) => Promise<EngineToolResult>
): EngineTool {
    const placeholders = extractPlaceholders(tool);
    return {
        name: safeToolName(tool.id),
        description: `${tool.name}: ${tool.description}`,
        parameters: schemaFromPlaceholders(placeholders),
        source: 'api',
        execute: args => execute(tool, args),
    };
}

export const FINDER_TOOL_NAME = 'workspace_finder';

export function makeFinderTool(
    run: (query: string, type?: string) => Promise<string>
): EngineTool {
    return {
        name: FINDER_TOOL_NAME,
        description: 'Durchsucht den Workspace: Aufgaben, Dokumente, Projekte, Chats und Termine.',
        parameters: {
            type: 'object',
            properties: {
                q: { type: 'string', description: 'Suchbegriff' },
                type: { type: 'string', enum: ['task', 'doc', 'project', 'chat', 'calendar'], description: 'Optionaler Typ-Filter' },
            },
            required: ['q'],
            additionalProperties: false,
        },
        source: 'builtin',
        execute: async args => {
            const query = typeof args.q === 'string' ? args.q : String(args.query ?? '');
            if (!query) return { text: 'Fehler: Parameter "q" (Suchbegriff) fehlt.' };
            const type = typeof args.type === 'string' ? args.type : undefined;
            return { text: await run(query, type) };
        },
    };
}

/**
 * Schreibende Workspace-Tools.
 *
 * Herkunft: Bis 2026-08-15 lagen „Aufgabe anlegen" und „Aufgabe ändern"
 * als CopilotKit-Actions in einem zweiten, parallel gepflegten Stack, den
 * nichts gerendert hat — die Actions waren damit für niemanden
 * erreichbar. Mit der Entscheidung aus ANALYSE §5 P0.3 ist der Stack
 * entfernt und die beiden Actions leben hier weiter: EIN Tool-Loop, eine
 * Beschreibung, beide Laufzeitpfade (Server und Browser).
 *
 * Beide sind konstruktiv im Sinne der Safety-Regeln (Anlegen, Ändern) und
 * brauchen deshalb keine Bestätigung; gelöscht wird über kein Tool.
 */
export const CREATE_TASK_TOOL_NAME = 'workspace_create_task';
export const UPDATE_TASK_TOOL_NAME = 'workspace_update_task';

const TASK_STATUS_VALUES = ['backlog', 'todo', 'in-progress', 'review', 'done', 'on-hold'] as const;
const TASK_PRIORITY_VALUES = ['low', 'medium', 'high', 'urgent'] as const;

/** Felder, die beide Aufgaben-Tools durchreichen (Auszug aus createTaskSchema). */
export interface TaskToolFields {
    title?: string;
    description?: string;
    status?: string;
    priority?: string;
    projectId?: string;
    dueDate?: string;
}

/** Übernimmt nur gesetzte, nicht-leere String-Felder — nie geraten. */
function readTaskFields(args: Record<string, unknown>): TaskToolFields {
    const fields: TaskToolFields = {};
    for (const key of ['title', 'description', 'status', 'priority', 'projectId', 'dueDate'] as const) {
        const value = args[key];
        if (typeof value === 'string' && value.trim() !== '') fields[key] = value;
    }
    return fields;
}

const TASK_FIELD_SCHEMA = {
    description: { type: 'string', description: 'Beschreibung (Markdown erlaubt)' },
    status: { type: 'string', enum: [...TASK_STATUS_VALUES], description: 'Status der Aufgabe' },
    priority: { type: 'string', enum: [...TASK_PRIORITY_VALUES], description: 'Priorität' },
    projectId: { type: 'string', description: 'ID des Projekts, zu dem die Aufgabe gehört' },
    dueDate: { type: 'string', description: 'Fälligkeit als ISO-Datum (YYYY-MM-DD)' },
} as const;

export function makeCreateTaskTool(
    run: (fields: TaskToolFields) => Promise<string>
): EngineTool {
    return {
        name: CREATE_TASK_TOOL_NAME,
        description: 'Legt eine neue Aufgabe im Workspace an.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Titel der Aufgabe' },
                ...TASK_FIELD_SCHEMA,
            },
            required: ['title'],
            additionalProperties: false,
        },
        source: 'builtin',
        execute: async args => {
            const fields = readTaskFields(args);
            if (!fields.title) return { text: 'Fehler: Parameter "title" (Titel) fehlt.' };
            return { text: await run(fields) };
        },
    };
}

export function makeUpdateTaskTool(
    run: (taskId: string, fields: TaskToolFields) => Promise<string>
): EngineTool {
    return {
        name: UPDATE_TASK_TOOL_NAME,
        description: `Ändert eine vorhandene Aufgabe. Die ID kommt aus ${FINDER_TOOL_NAME}.`,
        parameters: {
            type: 'object',
            properties: {
                taskId: { type: 'string', description: 'ID der Aufgabe' },
                title: { type: 'string', description: 'Neuer Titel' },
                ...TASK_FIELD_SCHEMA,
            },
            required: ['taskId'],
            additionalProperties: false,
        },
        source: 'builtin',
        execute: async args => {
            const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';
            if (!taskId) return { text: 'Fehler: Parameter "taskId" fehlt.' };
            const fields = readTaskFields(args);
            if (Object.keys(fields).length === 0) {
                return { text: 'Fehler: Es wurde kein zu änderndes Feld angegeben.' };
            }
            return { text: await run(taskId, fields) };
        },
    };
}

export const USE_SKILL_TOOL_NAME = 'use_skill';

export function makeUseSkillTool(
    skills: SkillMeta[],
    getContent: (id: string) => Promise<string | null>
): EngineTool {
    return {
        name: USE_SKILL_TOOL_NAME,
        description: 'Lädt den vollständigen Inhalt eines verfügbaren Skills (Anleitung), dem du danach folgst.',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Skill-ID aus der Liste VERFÜGBARE SKILLS' },
            },
            required: ['id'],
            additionalProperties: false,
        },
        source: 'builtin',
        execute: async args => {
            const id = String(args.id ?? '');
            const meta = skills.find(s => s.id === id || s.name === id);
            if (!meta) return { text: `Fehler: Skill "${id}" ist nicht verfügbar.` };
            const content = await getContent(meta.id);
            if (!content) return { text: `Fehler: Inhalt des Skills "${meta.name}" konnte nicht geladen werden.` };
            return { text: `SKILL „${meta.name}" — folge diesen Anweisungen:\n\n${content}` };
        },
    };
}

/** Namespaced engine tools for one MCP server. */
export function mcpToolsToEngineTools(
    serverId: string,
    serverLabel: string,
    descriptors: McpToolDescriptor[],
    call: (toolName: string, args: Record<string, unknown>) => Promise<McpCallOutcome>
): EngineTool[] {
    const prefix = `mcp_${safeToolName(serverId).slice(0, 12)}`;
    return descriptors.map(descriptor => ({
        name: safeToolName(`${prefix}_${descriptor.name}`),
        description: `[${serverLabel}] ${descriptor.description || descriptor.name}`,
        parameters: descriptor.inputSchema && typeof descriptor.inputSchema === 'object'
            ? descriptor.inputSchema
            : { type: 'object', additionalProperties: true },
        source: 'mcp',
        execute: async args => {
            const outcome = await call(descriptor.name, args);
            return {
                text: outcome.isError ? `Fehler vom MCP-Server: ${outcome.text}` : outcome.text,
                uiResources: outcome.uiResources,
            };
        },
    }));
}

/** Derive the prompt documentation line for an engine tool. */
export function toPromptInfo(tool: EngineTool): PromptToolInfo {
    let argsHint: string | undefined;
    const params = tool.parameters as { properties?: Record<string, unknown>; required?: string[] };
    const propertyNames = params?.properties ? Object.keys(params.properties) : [];
    if (propertyNames.length > 0) {
        const required = new Set(params.required ?? []);
        argsHint = `{${propertyNames.map(p => `"${p}":${required.has(p) ? '…' : '…?'}`).join(',')}}`;
    }
    return {
        name: tool.name,
        description: tool.description,
        argsHint,
        source: tool.source,
    };
}
