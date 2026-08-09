/**
 * `mcp-server`-Connector (SPEC §6.3, Meilenstein M9): Tools und Prompts
 * eines MCP-Servers werden als `ow:Tool`-/`ow:Skill`-Knoten unter einem
 * `ow:ToolProvider` materialisiert — read-only, über den EINEN
 * Connector-Vertrag (Invariante 5).
 *
 * Der Protokoll-Client wird wiederverwendet, nicht neu gebaut (SPEC §1):
 * `describeMcpServer` aus `src/lib/ai/mcp/client.ts` holt Server-Info,
 * Tools und Prompts über EINE Verbindung (Streamable HTTP mit
 * SSE-Fallback). Alle Transport-Requests laufen über `ctx.fetch`
 * (SSRF-Guard) — lokale Server brauchen wie überall
 * `ALLOW_LOCAL_TOOL_URLS=1`.
 *
 * Mapping (SPEC §4.2): Server → ow:ToolProvider + schema:SoftwareApplication
 * mit ow:endpoint/ow:transport; Tool → ow:Tool mit ow:inputSchema
 * (JSON-Schema als Literal — eine RDF-Abbildung wäre verlustbehaftet) und
 * ow:providedBy; Prompt → ow:Skill mit ow:providesSkill vom Server (das
 * ist derselbe Weg, über den Prompts heute als Skills importierbar sind).
 *
 * Revision = SHA-256 über das kanonisch sortierte Inventar (Server-Info,
 * Transport, Tools, Prompts): unverändertes Inventar ⇒ No-Op.
 */

import type { Quad } from '@rdfjs/types';
import { z } from 'zod';
import { describeMcpServer, type McpInventory } from '@/lib/ai/mcp/client';
import type { Connector, ConnectorContext, QuarantineEntry, SourceRef } from './types';
import { sha256Hex } from './quads';
import type { IriFactory } from '../iri';
import { factory, namedNode, literal, typedLiteral } from '../rdf';
import { DCTERMS, OW, RDF, SCHEMA } from '../vocab';

const TRANSPORTS = ['auto', 'streamable-http', 'sse'] as const;

const configSchema = z.object({
    /** Streamable-HTTP- (oder Legacy-SSE-) Endpoint des MCP-Servers. */
    url: z.url({ protocol: /^https?$/ }),
    transport: z.enum(TRANSPORTS).default('auto'),
});

export type McpServerConnectorConfig = z.infer<typeof configSchema>;

const LOCATOR_TRANSPORT_MARK = '#transport=';

/** Inventar deterministisch sortiert — Grundlage von Revision und Quads. */
function normalizedInventory(inventory: McpInventory): McpInventory {
    return {
        server: inventory.server,
        transport: inventory.transport,
        tools: [...inventory.tools].sort((a, b) => a.name.localeCompare(b.name)),
        prompts: [...inventory.prompts].sort((a, b) => a.name.localeCompare(b.name)),
    };
}

async function inventoryRevision(inventory: McpInventory): Promise<string> {
    const canonical = JSON.stringify({
        server: { name: inventory.server.name ?? null, version: inventory.server.version ?? null },
        transport: inventory.transport,
        tools: inventory.tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
        })),
        prompts: inventory.prompts.map(prompt => ({
            name: prompt.name,
            title: prompt.title ?? null,
            description: prompt.description,
        })),
    });
    return `sha256:${await sha256Hex(canonical)}`;
}

async function fetchInventory(config: McpServerConnectorConfig, ctx: ConnectorContext): Promise<McpInventory> {
    return normalizedInventory(await describeMcpServer({
        url: config.url,
        transport: config.transport,
        fetchImpl: (url, init) => ctx.fetch(url, init),
    }));
}

/**
 * Reines Mapping Inventar → Quads (ohne Graph-Komponente — den
 * Ziel-Graphen erzwingt der Runner). Exportiert für die M9-Abnahme.
 */
export function mcpInventoryQuads(
    iri: IriFactory,
    connectorId: string,
    endpointUrl: string,
    inventory: McpInventory,
    quarantine: (entry: QuarantineEntry) => void,
): Quad[] {
    const provider = namedNode(iri.entity('tool-provider', connectorId));
    const type = namedNode(RDF.type);
    const quads: Quad[] = [
        factory.quad(provider, type, namedNode(OW.ToolProvider)),
        factory.quad(provider, type, namedNode(SCHEMA.SoftwareApplication)),
        factory.quad(provider, namedNode(SCHEMA.name), literal(inventory.server.name ?? new URL(endpointUrl).host)),
        factory.quad(provider, namedNode(OW.endpoint), typedLiteral.anyUri(endpointUrl)),
        factory.quad(provider, namedNode(OW.transport), literal(inventory.transport)),
    ];
    if (inventory.server.version) {
        quads.push(factory.quad(provider, namedNode(SCHEMA.softwareVersion), literal(inventory.server.version)));
    }

    const seenTools = new Set<string>();
    for (const tool of inventory.tools) {
        if (tool.name.trim() === '') {
            quarantine({ source: `${endpointUrl}#tools`, reason: 'Tool ohne Namen — übersprungen.' });
            continue;
        }
        if (seenTools.has(tool.name)) {
            quarantine({ source: `${endpointUrl}#tools/${tool.name}`, reason: 'Doppelter Tool-Name — nur der erste Eintrag wird importiert.' });
            continue;
        }
        seenTools.add(tool.name);
        const node = namedNode(iri.entity('tool', `${connectorId}/${tool.name}`));
        quads.push(
            factory.quad(node, type, namedNode(OW.Tool)),
            factory.quad(node, namedNode(SCHEMA.name), literal(tool.name)),
            factory.quad(node, namedNode(DCTERMS.identifier), literal(tool.name)),
            factory.quad(node, namedNode(OW.inputSchema), literal(JSON.stringify(tool.inputSchema))),
            factory.quad(node, namedNode(OW.providedBy), provider),
        );
        if (tool.description.trim() !== '') {
            quads.push(factory.quad(node, namedNode(SCHEMA.description), literal(tool.description)));
        }
    }

    const seenPrompts = new Set<string>();
    for (const prompt of inventory.prompts) {
        if (prompt.name.trim() === '') {
            quarantine({ source: `${endpointUrl}#prompts`, reason: 'Prompt ohne Namen — übersprungen.' });
            continue;
        }
        if (seenPrompts.has(prompt.name)) {
            quarantine({ source: `${endpointUrl}#prompts/${prompt.name}`, reason: 'Doppelter Prompt-Name — nur der erste Eintrag wird importiert.' });
            continue;
        }
        seenPrompts.add(prompt.name);
        const node = namedNode(iri.entity('skill', `${connectorId}/${prompt.name}`));
        quads.push(
            factory.quad(node, type, namedNode(OW.Skill)),
            factory.quad(node, namedNode(SCHEMA.name), literal(prompt.title ?? prompt.name)),
            factory.quad(node, namedNode(DCTERMS.identifier), literal(prompt.name)),
            factory.quad(node, namedNode(OW.skillSource), literal(`mcp-prompt:${endpointUrl}#${prompt.name}`)),
            factory.quad(provider, namedNode(OW.providesSkill), node),
        );
        if (prompt.description.trim() !== '') {
            quads.push(
                factory.quad(node, namedNode(SCHEMA.description), literal(prompt.description)),
                // SKILL.md-Konvention: die Beschreibung sagt, wann der Skill greift.
                factory.quad(node, namedNode(OW.trigger), literal(prompt.description)),
            );
        }
    }

    return quads;
}

export const mcpServerConnector: Connector<McpServerConnectorConfig> = {
    kind: 'mcp-server',
    mode: 'materialize',
    capabilities: { read: true, write: false, watch: false, lossyExport: false },
    label: 'MCP-Server',
    description: 'Werkzeug-Inventar eines MCP-Servers (Streamable HTTP, SSE-Fallback): Tools mit JSON-Schema und Prompts als Skills werden unter dem Server als ow:ToolProvider abfragbar.',

    configSchema: () => z.toJSONSchema(configSchema) as Record<string, unknown>,
    parseConfig: input => configSchema.parse(input),

    // Transport wandert als Fragment in den Locator (kein Request-Bestandteil,
    // für Menschen lesbar). Endpoint-URLs mit eigenem `#transport=`-Fragment
    // sind damit nicht abbildbar — MCP-Endpoints tragen keine Fragmente.
    locatorFor: config => config.transport === 'auto'
        ? config.url
        : `${config.url}${LOCATOR_TRANSPORT_MARK}${config.transport}`,
    configFromLocator: locator => {
        const markIndex = locator.lastIndexOf(LOCATOR_TRANSPORT_MARK);
        if (markIndex === -1) return configSchema.parse({ url: locator });
        return configSchema.parse({
            url: locator.slice(0, markIndex),
            transport: locator.slice(markIndex + LOCATOR_TRANSPORT_MARK.length),
        });
    },

    async probe(config, ctx): Promise<SourceRef> {
        const inventory = await fetchInventory(config, ctx);
        return {
            id: '',
            kind: this.kind,
            locator: this.locatorFor(config),
            revision: await inventoryRevision(inventory),
            fetchedAt: new Date().toISOString(),
        };
    },

    async *pull(ref: SourceRef, ctx: ConnectorContext): AsyncIterable<Quad> {
        const config = this.configFromLocator(ref.locator);
        ctx.report({ done: 0, total: 1, note: 'Lade MCP-Inventar…' });
        const inventory = await fetchInventory(config, ctx);
        yield* mcpInventoryQuads(ctx.iri, ref.id, config.url, inventory, entry => ctx.quarantine(entry));
        ctx.report({ done: 1, total: 1 });
    },
};
