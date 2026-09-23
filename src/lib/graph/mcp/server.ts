/**
 * MCP-Server des Graphen (SPEC §7.6, M10; seit A2 aus der Registry).
 *
 * Der Workspace war bisher MCP-**Client** (`src/lib/ai/mcp/client.ts`);
 * hier wird er zusätzlich MCP-**Server**, damit externe Agenten auf dem
 * Graphen retrieven können, ohne SPARQL zu sprechen. Dieselbe SDK, die
 * schon den Client trägt — kein zweites Protokoll-Framework.
 *
 * Das Werkzeug-Inventar ist seit A2 keine Handliste mehr: Es sind die
 * Aktionen der Registry (ACTIONS_SPEC §3), nach Effektklasse und
 * Token-Recht gefiltert — `read` per Default, `constructive` nur, wenn
 * das Token einen Schreibgraphen freigibt (das bisherige
 * `graph_write`-Muster), `destructive` nie. Was der Grant nicht erreicht
 * oder was dem Kontext fehlt (Store-first-CRUD, Oberfläche), erscheint
 * nicht: kein totes Werkzeug im Inventar (Invariante 10). Der Server
 * wird PRO SITZUNG über den Grant des Tokens gebaut.
 *
 * Knoten als Resources (`graph://<iri>`, Turtle + JSON-LD) und die
 * gespeicherten Retrieval-Profile (M8) als Prompts bleiben.
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ActionError, type Action, type ActionContext, type ActionEffect } from '@/lib/actions/contract';
import { executeAction } from '@/lib/actions/execute';
import { visibleActions } from '@/lib/actions/tools';
import '@/lib/actions/catalog';
import { listRetrievalProfiles } from '../search/profiles';
import { ShaclViolationError } from '../reasoning/shacl';
import {
    listGraphResources,
    mcpRetrieve,
    readGraphResource,
    type McpGraphContext,
} from './tools';
import { MCP_TOOL_TIMEOUT_MS, toolTimeoutMs, withTimeout } from './limits';

export const MCP_SERVER_INFO = {
    name: 'open-workspace-graph',
    version: '1.0.0',
    title: 'Open Workspace — Graph',
} as const;

/** Namen der Graph-Werkzeuge aus SPEC §7.6 (Reihenfolge = Tabelle der Spec). */
export const MCP_TOOL_NAMES = [
    'graph_search',
    'graph_retrieve',
    'graph_neighbors',
    'graph_describe',
    'graph_sparql',
    'graph_write',
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/**
 * Effektklassen, die dieses Token sieht (ACTIONS_SPEC §3): Lesen immer,
 * Anlegen/Ändern nur mit freigegebenem Schreibgraphen. Löschen nie.
 */
export function mcpVisibleEffects(ctx: Pick<ActionContext, 'grant'>): ActionEffect[] {
    return ctx.grant.writableGraph ? ['read', 'constructive'] : ['read'];
}

/** Welche Werkzeuge dieser Kontext tatsächlich sieht (Status-UI + Tests). */
export async function mcpToolsFor(ctx: ActionContext): Promise<Action[]> {
    return visibleActions(ctx, mcpVisibleEffects(ctx));
}

export async function toolsForContext(ctx: ActionContext): Promise<string[]> {
    return (await mcpToolsFor(ctx)).map(action => action.name);
}

function jsonResult(payload: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message: string) {
    return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/** Fehler einer Aktion als MCP-Fehlerergebnis — der Client sieht die Ursache, nie einen Stack. */
function describeFailure(error: unknown): string {
    if (error instanceof ActionError) {
        const details = error.details === undefined
            ? ''
            : ` (${typeof error.details === 'string' ? error.details : JSON.stringify(error.details)})`;
        return `${error.message}${details}`;
    }
    if (error instanceof ShaclViolationError) return `SHACL-Verletzung: ${error.message}`;
    return error instanceof Error ? error.message : 'Unbekannter Fehler';
}

export async function createGraphMcpServer(ctx: McpGraphContext): Promise<McpServer> {
    const server = new McpServer(MCP_SERVER_INFO, {
        capabilities: { tools: {}, resources: {}, prompts: {} },
        instructions:
            'Wissensgraph des Open Workspace. graph_search findet Einstiegsknoten, ' +
            'graph_retrieve liefert Multi-Hop-Kontext mit Provenienz und Erklärung, ' +
            'graph_neighbors und graph_describe sind die günstigen Einzelabfragen; ' +
            'workspace_* liest und schreibt Aufgaben, Dokumente, Projekte und Pinnwände. ' +
            'Knoten sind als Resource graph://<iri> referenzierbar. Es ist immer nur ' +
            'der Teil des Graphen sichtbar, den das benutzte Token lesen darf.',
    });

    for (const action of await mcpToolsFor(ctx.actions)) {
        const annotations = action.effect === 'read'
            ? { readOnlyHint: true }
            : { readOnlyHint: false, destructiveHint: false };
        server.registerTool(action.name, {
            title: action.title ?? action.name,
            description: action.name === 'graph_write' && ctx.grant.writableGraph
                ? `${action.description} Ziel: <${ctx.grant.writableGraph}>.`
                : action.description,
            annotations,
            inputSchema: action.input,
        }, async args => {
            try {
                const result = await withTimeout(action.name, toolTimeoutMs(action.name), () =>
                    executeAction(action, args, ctx.actions));
                // graph_sparql liefert den Rumpf im verhandelten Format, nicht als JSON-Hülle.
                if (action.name === 'graph_sparql') {
                    return { content: [{ type: 'text' as const, text: (result.output as { body: string }).body }] };
                }
                return jsonResult(result.output);
            } catch (error) {
                return errorResult(describeFailure(error));
            }
        });
    }

    // --- Resources: Knoten als graph://<iri> ------------------------------
    server.registerResource(
        'graph-node',
        new ResourceTemplate('graph://{iri}', {
            list: async () => ({
                resources: (await listGraphResources(ctx)).map(entry => ({
                    uri: entry.uri,
                    name: entry.name,
                    description: entry.description,
                    mimeType: 'text/turtle',
                })),
            }),
        }),
        {
            title: 'Graph-Knoten',
            description: 'Ein Knoten des erlaubten Datasets als Turtle und JSON-LD.',
            mimeType: 'text/turtle',
        },
        async (uri, variables) => {
            const raw = variables.iri;
            const iri = decodeURIComponent(Array.isArray(raw) ? raw[0] ?? '' : raw ?? '');
            const contents = await withTimeout('resource', MCP_TOOL_TIMEOUT_MS.resource, () => readGraphResource(ctx, iri));
            if (contents.length === 0) {
                // Keine Existenzbestätigung: außerhalb des Datasets sieht
                // ein Knoten genauso aus wie ein nicht vorhandener.
                return { contents: [{ uri: uri.href, mimeType: 'text/turtle', text: '' }] };
            }
            return { contents };
        },
    );

    return server;
}

/**
 * Registriert die gespeicherten Retrieval-Profile (M8) als MCP-Prompts.
 * Getrennt vom Server-Bau, weil dafür der Store gelesen wird — der
 * Aufrufer entscheidet, ob er das pro Verbindung tun will.
 */
export async function registerRetrievalPrompts(server: McpServer, ctx: McpGraphContext): Promise<number> {
    const profiles = await listRetrievalProfiles(ctx.handle);
    for (const profile of profiles) {
        server.registerPrompt(`retrieval_${profile.id}`, {
            title: profile.name,
            description: profile.description ?? `Retrieval-Profil „${profile.name}" (${JSON.stringify(profile.config)}).`,
            argsSchema: { query: z.string().describe('Suchtext für das Seeding') },
        }, async ({ query }) => {
            const result = await withTimeout('graph_retrieve', MCP_TOOL_TIMEOUT_MS.graph_retrieve, () =>
                mcpRetrieve(ctx, { ...profile.config, format: 'context', seeds: { text: query } }));
            return {
                messages: [{
                    role: 'user' as const,
                    content: {
                        type: 'text' as const,
                        text: `Kontext aus dem Wissensgraphen (Profil „${profile.name}", Frage: ${query}):\n\n${result.context ?? '(kein Treffer)'}`,
                    },
                }],
            };
        });
    }
    return profiles.length;
}
