/**
 * M9-Abnahme (GRAPH_CORE_SPEC §13): Agents, Skills, Tools als Graph-Bürger.
 *
 *  1. Der Assistent kann per SPARQL beantworten, welche Skills welche
 *     Tools benötigen und welcher Agent sie anbietet — über den nativen
 *     AI-Spiegel (graph/meta) UND über die Import-Graphen der neuen
 *     Connectors hinweg.
 *  2. `a2a-agent-card`: Agent-Card → foaf:Agent/ow:Agent-Knoten mit
 *     ow:agentCardUrl/ow:endpoint/ow:securityScheme und Card-Skills als
 *     ow:Skill (ow:providesSkill); Discovery-Reihenfolge des A2A-Clients;
 *     M3-Regeln (PROV, No-Op, Replace, Quarantäne) gelten unverändert.
 *  3. `mcp-server`: läuft END-TO-END über den echten SDK-Client gegen
 *     einen Streamable-HTTP-Stub — Server → ow:ToolProvider, Tools →
 *     ow:Tool mit ow:inputSchema (JSON-Literal), Prompts → ow:Skill.
 *  4. AI-Spiegel: deterministisch, nur enabled-Einträge, [[TOOL:…]]-Bedarf
 *     als ow:requiresTool, abschnittsweiser Replace ohne Kollateralschaden
 *     an der Connector-Registry in graph/meta.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import type { Quad } from '@rdfjs/types';
import { OxigraphStore } from '@/lib/graph/store/oxigraph';
import { createIriFactory } from '@/lib/graph/iri';
import { namedNode } from '@/lib/graph/rdf';
import { DCTERMS, FOAF, OW, SCHEMA, SPARQL_PREFIXES } from '@/lib/graph/vocab';
import { createConnector, type GraphHandle } from '@/lib/graph/connectors/registry';
import { syncConnector } from '@/lib/graph/connectors/sync';
import { a2aAgentCardConnector } from '@/lib/graph/connectors/a2a-agent-card';
import { mcpServerConnector } from '@/lib/graph/connectors/mcp-server';
import { getConnectorKind } from '@/lib/graph/connectors/catalog';
import {
    aiMirrorQuads,
    referencedToolNames,
    replaceAiMirror,
    type AiMirrorInput,
} from '@/lib/graph/meta/ai';
import type { Skill } from '@/lib/skills/types';
import type { Agent } from '@/lib/agents/types';
import type { Tool } from '@/lib/tools/types';
import type { McpServerConfig } from '@/lib/ai/types';

const INSTANCE_BASE = 'urn:ow:12345678-1234-1234-1234-123456789abc:';

type Route = (init?: RequestInit) => Response | Promise<Response>;

function makeFetchStub(routes: Map<string, Route>, log: string[]): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        log.push(`${init?.method ?? 'GET'} ${url}`);
        const route = routes.get(url);
        if (!route) return new Response('not found', { status: 404 });
        return route(init);
    }) as typeof fetch;
}

function jsonResponse(body: unknown): Route {
    return () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function dumpGraph(handle: GraphHandle, graphIri: string): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const q of handle.store.dump(namedNode(graphIri))) {
        quads.push(q);
    }
    return quads;
}

function objectValues(quads: Quad[], subject: string, predicate: string): string[] {
    return quads
        .filter(q => q.subject.value === subject && q.predicate.value === predicate)
        .map(q => q.object.value)
        .sort();
}

function fixedClock(): () => Date {
    let tick = 0;
    return () => new Date(Date.UTC(2026, 7, 9, 12, 0, tick += 1));
}

async function selectAll(
    handle: GraphHandle,
    sparql: string,
): Promise<Array<Record<string, string>>> {
    const result = await handle.store.query(`${SPARQL_PREFIXES}\n${sparql}`);
    if (result.type !== 'bindings') throw new Error('SELECT erwartet');
    const rows: Array<Record<string, string>> = [];
    for await (const binding of result.bindings) {
        const row: Record<string, string> = {};
        for (const [key, term] of Object.entries(binding)) {
            row[key] = term.value;
        }
        rows.push(row);
    }
    return rows;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENT_ORIGIN = 'https://agent.example.org';
const CARD_URL = `${AGENT_ORIGIN}/.well-known/agent-card.json`;

const AGENT_CARD = {
    name: 'Recherche-Agent',
    description: 'Beantwortet Rechercheaufträge.',
    version: '2.1.0',
    url: `${AGENT_ORIGIN}/rpc`,
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    skills: [
        { id: 'web-research', name: 'Web-Recherche', description: 'Findet Quellen im Netz.', tags: ['recherche', 'web'] },
        { id: 'summarize', name: 'Zusammenfassen' },
    ],
};

const MCP_URL = 'https://mcp.example.org/mcp';

interface McpStubInventory {
    serverInfo: { name: string; version: string };
    /** Fehlt das Feld, bewirbt der Stub die Capability nicht. */
    tools?: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
    prompts?: Array<{ name: string; title?: string; description?: string }>;
}

/**
 * Minimaler Streamable-HTTP-MCP-Server als fetch-Stub: beantwortet
 * initialize/tools/list/prompts/list als JSON-RPC über application/json.
 * Damit läuft der Connector durch den ECHTEN SDK-Client — kein
 * nachgebauter Protokollpfad.
 */
function mcpStubRoute(inventory: McpStubInventory): Route {
    const rpc = (id: unknown, result: unknown) => new Response(
        JSON.stringify({ jsonrpc: '2.0', id, result }),
        { status: 200, headers: { 'content-type': 'application/json' } },
    );
    return async init => {
        if ((init?.method ?? 'GET') === 'GET') {
            // Kein server-initiierter SSE-Stream — laut Spec erlaubt.
            return new Response('Method Not Allowed', { status: 405 });
        }
        if (init?.method === 'DELETE') return new Response(null, { status: 405 });
        const message = JSON.parse(String(init?.body)) as { id?: unknown; method?: string };
        if (message.method === 'initialize') {
            return rpc(message.id, {
                protocolVersion: '2025-06-18',
                capabilities: {
                    ...(inventory.tools ? { tools: {} } : {}),
                    ...(inventory.prompts ? { prompts: {} } : {}),
                },
                serverInfo: inventory.serverInfo,
            });
        }
        if (message.method === 'notifications/initialized') {
            return new Response(null, { status: 202 });
        }
        if (message.method === 'tools/list' && inventory.tools) {
            return rpc(message.id, { tools: inventory.tools });
        }
        if (message.method === 'prompts/list' && inventory.prompts) {
            return rpc(message.id, { prompts: inventory.prompts });
        }
        return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32601, message: 'Method not found' } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        );
    };
}

function skillFixture(overrides: Partial<Skill> & { id: string }): Skill {
    return {
        name: overrides.id,
        description: '',
        content: '',
        source: { type: 'manual' },
        enabled: true,
        alwaysInject: false,
        createdAt: '2026-08-01T10:00:00.000Z',
        updatedAt: '2026-08-02T10:00:00.000Z',
        ...overrides,
    };
}

function agentFixture(overrides: Partial<Agent> & { id: string; type: Agent['type'] }): Agent {
    return {
        name: overrides.id,
        description: '',
        config: {},
        enabled: true,
        createdAt: '2026-08-01T10:00:00.000Z',
        updatedAt: '2026-08-02T10:00:00.000Z',
        ...overrides,
    };
}

const MIRROR_INPUT: AiMirrorInput = {
    skills: [
        skillFixture({
            id: 'skill-wetterbericht',
            name: 'Wetterbericht',
            description: 'Wenn nach dem Wetter gefragt wird.',
            content: 'Rufe [[TOOL:api-wetter:{"ort":"Berlin"}]] auf und fasse mit [[TOOL:workspace_finder:{"q":"Wetter"}]] zusammen.',
            source: { type: 'repo', ref: 'pajew-ski/skills/wetter' },
        }),
        skillFixture({ id: 'skill-inaktiv', name: 'Deaktiviert', enabled: false }),
    ],
    agents: [
        agentFixture({
            id: 'agent-recherche',
            type: 'remote_a2a',
            name: 'Remote-Recherche',
            description: 'Delegiert Recherche an einen A2A-Agenten.',
            config: {
                endpointUrl: `${AGENT_ORIGIN}/rpc`,
                cardUrl: CARD_URL,
                capabilities: ['Web-Recherche', 'Zusammenfassen'],
            },
        }),
        agentFixture({ id: 'agent-lokal', type: 'local', name: 'Schreib-Persona', config: { systemPrompt: 'Du schreibst.' } }),
        agentFixture({ id: 'agent-aus', type: 'local', enabled: false }),
    ],
    apiTools: [
        {
            id: 'api-wetter',
            name: 'Wetter-API',
            description: 'Aktuelles Wetter je Ort.',
            type: 'api',
            config: { url: 'https://wetter.example.org/{ort}' },
            enabled: true,
            createdAt: '2026-08-01T10:00:00.000Z',
        } satisfies Tool,
        {
            id: 'api-aus',
            name: 'Deaktiviert',
            description: '',
            type: 'api',
            config: {},
            enabled: false,
            createdAt: '2026-08-01T10:00:00.000Z',
        } satisfies Tool,
    ],
    mcpServers: [
        {
            id: 'srv1',
            label: 'Beispiel-MCP',
            url: MCP_URL,
            transport: 'auto',
            connectionMode: 'server',
            enabled: true,
            createdAt: '2026-08-01T10:00:00.000Z',
            updatedAt: '2026-08-02T10:00:00.000Z',
        } as McpServerConfig,
    ],
};

// ---------------------------------------------------------------------------
// a2a-agent-card
// ---------------------------------------------------------------------------

describe('a2a-agent-card-Connector (M9)', () => {
    let handle: GraphHandle;
    let routes: Map<string, Route>;
    let log: string[];
    let fetchImpl: typeof fetch;

    beforeEach(() => {
        handle = { store: new OxigraphStore(), iri: createIriFactory(INSTANCE_BASE) };
        routes = new Map();
        log = [];
        fetchImpl = makeFetchStub(routes, log);
    });

    it('ist im Katalog registriert und der Locator-Round-Trip ist verlustfrei', () => {
        expect(getConnectorKind('a2a-agent-card')).toBe(a2aAgentCardConnector);
        const config = { url: AGENT_ORIGIN };
        expect(a2aAgentCardConnector.configFromLocator(a2aAgentCardConnector.locatorFor(config))).toEqual(config);
    });

    it('materialisiert die Card als ow:Agent mit Skills, PROV und Discovery über well-known', async () => {
        routes.set(CARD_URL, jsonResponse(AGENT_CARD));
        const view = await createConnector(handle, {
            id: 'a2a-test', name: 'Recherche-Agent', kind: 'a2a-agent-card', locator: AGENT_ORIGIN,
        });
        const result = await syncConnector(handle, 'a2a-test', { fetchImpl, now: fixedClock() });
        expect(result.status).toBe('imported');
        expect(result.quarantined).toEqual([]);
        // Discovery-Reihenfolge des A2A-Clients: erst agent-card.json.
        expect(log[0]).toBe(`GET ${CARD_URL}`);

        const imported = await dumpGraph(handle, view.targetGraph);
        const agentIri = handle.iri.entity('agent', 'a2a-test');
        const types = objectValues(imported, agentIri, `${'http://www.w3.org/1999/02/22-rdf-syntax-ns#'}type`);
        expect(types).toContain(OW.Agent);
        expect(types).toContain(FOAF.Agent);
        expect(types).toContain(SCHEMA.SoftwareApplication);
        expect(objectValues(imported, agentIri, SCHEMA.name)).toEqual(['Recherche-Agent']);
        expect(objectValues(imported, agentIri, OW.agentCardUrl)).toEqual([CARD_URL]);
        expect(objectValues(imported, agentIri, OW.endpoint)).toEqual([`${AGENT_ORIGIN}/rpc`]);
        expect(objectValues(imported, agentIri, SCHEMA.softwareVersion)).toEqual(['2.1.0']);
        const schemes = objectValues(imported, agentIri, OW.securityScheme);
        expect(schemes).toHaveLength(1);
        expect(JSON.parse(schemes[0])).toEqual(AGENT_CARD.securitySchemes);

        // Card-Skills als ow:Skill mit ow:providesSkill-Kante.
        const skillIri = handle.iri.entity('skill', 'a2a-test/web-research');
        expect(objectValues(imported, agentIri, OW.providesSkill)).toEqual([
            skillIri,
            handle.iri.entity('skill', 'a2a-test/summarize'),
        ].sort());
        expect(objectValues(imported, skillIri, SCHEMA.name)).toEqual(['Web-Recherche']);
        expect(objectValues(imported, skillIri, SCHEMA.keywords)).toEqual(['recherche', 'web']);
        expect(objectValues(imported, skillIri, OW.skillSource)).toEqual([`a2a-card:${CARD_URL}`]);

        // PROV liegt am Import-Graphen (Runner, M3-Regel).
        expect(objectValues(imported, view.targetGraph, 'http://www.w3.org/ns/prov#wasDerivedFrom')).toEqual([AGENT_ORIGIN]);
        expect(objectValues(imported, view.targetGraph, OW.revision)).toHaveLength(1);
    });

    it('erkennt unveränderte Cards als No-Op und ersetzt bei Änderung vollständig', async () => {
        routes.set(CARD_URL, jsonResponse(AGENT_CARD));
        await createConnector(handle, { id: 'a2a-noop', name: 'A', kind: 'a2a-agent-card', locator: AGENT_ORIGIN });
        const first = await syncConnector(handle, 'a2a-noop', { fetchImpl, now: fixedClock() });
        expect(first.status).toBe('imported');
        const second = await syncConnector(handle, 'a2a-noop', { fetchImpl, now: fixedClock() });
        expect(second.status).toBe('noop');

        // Geänderte Card: der alte Skill verschwindet (Replace, kein Merge).
        routes.set(CARD_URL, jsonResponse({ ...AGENT_CARD, skills: [{ id: 'only-new', name: 'Neu' }] }));
        const third = await syncConnector(handle, 'a2a-noop', { fetchImpl, now: fixedClock() });
        expect(third.status).toBe('imported');
        const imported = await dumpGraph(handle, handle.iri.importGraph('a2a-noop'));
        const skillIris = imported.filter(q => q.predicate.value === OW.providesSkill).map(q => q.object.value);
        expect(skillIris).toEqual([handle.iri.entity('skill', 'a2a-noop/only-new')]);
    });

    it('quarantäniert kaputte Skill-Einträge, ohne den Import abzubrechen', async () => {
        routes.set(CARD_URL, jsonResponse({ ...AGENT_CARD, skills: [{ id: 'ok', name: 'OK' }, 'kaputt', 42] }));
        await createConnector(handle, { id: 'a2a-q', name: 'Q', kind: 'a2a-agent-card', locator: AGENT_ORIGIN });
        const result = await syncConnector(handle, 'a2a-q', { fetchImpl, now: fixedClock() });
        expect(result.status).toBe('imported');
        expect(result.quarantined).toHaveLength(2);
        expect(result.quarantined[0].source).toContain('skills[1]');
        const imported = await dumpGraph(handle, handle.iri.importGraph('a2a-q'));
        expect(imported.filter(q => q.predicate.value === OW.providesSkill)).toHaveLength(1);
    });

    it('importiert eine explizit benannte, unbrauchbare Card-URL als Quarantäne statt Fehler', async () => {
        const explicitUrl = `${AGENT_ORIGIN}/card.json`;
        routes.set(explicitUrl, () => new Response('<html>keine Card</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
        await createConnector(handle, { id: 'a2a-html', name: 'H', kind: 'a2a-agent-card', locator: explicitUrl });
        const result = await syncConnector(handle, 'a2a-html', { fetchImpl, now: fixedClock() });
        expect(result.status).toBe('imported');
        expect(result.quarantined).toHaveLength(1);
        expect(result.quarantined[0].reason).toContain('kein JSON-Objekt');
        // Nur PROV im Graphen, keine Agent-Aussagen.
        const imported = await dumpGraph(handle, handle.iri.importGraph('a2a-html'));
        expect(imported.every(q => q.subject.value === handle.iri.importGraph('a2a-html'))).toBe(true);
    });

    it('meldet eine nicht auffindbare Card als Infrastrukturfehler (status failed)', async () => {
        await createConnector(handle, { id: 'a2a-404', name: 'F', kind: 'a2a-agent-card', locator: AGENT_ORIGIN });
        const result = await syncConnector(handle, 'a2a-404', { fetchImpl, now: fixedClock() });
        expect(result.status).toBe('failed');
        expect(result.message).toContain('Agent Card nicht gefunden');
    });
});

// ---------------------------------------------------------------------------
// mcp-server
// ---------------------------------------------------------------------------

describe('mcp-server-Connector (M9) — end-to-end über den SDK-Client', () => {
    let handle: GraphHandle;
    let routes: Map<string, Route>;
    let log: string[];
    let fetchImpl: typeof fetch;

    const inventory = {
        serverInfo: { name: 'stub-mcp', version: '1.2.3' },
        tools: [
            { name: 'search', description: 'Suche im Bestand.', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
            { name: 'fetch_doc', inputSchema: { type: 'object' } },
        ],
        prompts: [
            { name: 'triage', title: 'Triage-Anleitung', description: 'Wenn ein Ticket einzuordnen ist.' },
        ],
    } satisfies McpStubInventory;

    beforeEach(() => {
        handle = { store: new OxigraphStore(), iri: createIriFactory(INSTANCE_BASE) };
        routes = new Map();
        log = [];
        fetchImpl = makeFetchStub(routes, log);
        routes.set(MCP_URL, mcpStubRoute(inventory));
    });

    it('Locator-Round-Trip trägt den Transport verlustfrei', () => {
        expect(getConnectorKind('mcp-server')).toBe(mcpServerConnector);
        for (const transport of ['auto', 'streamable-http', 'sse'] as const) {
            const config = { url: MCP_URL, transport };
            expect(mcpServerConnector.configFromLocator(mcpServerConnector.locatorFor(config))).toEqual(config);
        }
    });

    it('materialisiert Server, Tools und Prompts als ToolProvider/Tool/Skill', async () => {
        const view = await createConnector(handle, {
            id: 'mcp-test', name: 'Beispiel-MCP', kind: 'mcp-server', locator: MCP_URL,
        });
        const result = await syncConnector(handle, 'mcp-test', { fetchImpl, now: fixedClock() });
        expect(result.status).toBe('imported');
        expect(result.quarantined).toEqual([]);

        const imported = await dumpGraph(handle, view.targetGraph);
        const providerIri = handle.iri.entity('tool-provider', 'mcp-test');
        expect(objectValues(imported, providerIri, SCHEMA.name)).toEqual(['stub-mcp']);
        expect(objectValues(imported, providerIri, SCHEMA.softwareVersion)).toEqual(['1.2.3']);
        expect(objectValues(imported, providerIri, OW.endpoint)).toEqual([MCP_URL]);
        expect(objectValues(imported, providerIri, OW.transport)).toEqual(['streamable-http']);

        const toolIri = handle.iri.entity('tool', 'mcp-test/search');
        expect(objectValues(imported, toolIri, OW.providedBy)).toEqual([providerIri]);
        expect(objectValues(imported, toolIri, DCTERMS.identifier)).toEqual(['search']);
        const schema = objectValues(imported, toolIri, OW.inputSchema);
        expect(JSON.parse(schema[0])).toEqual(inventory.tools[0].inputSchema);

        const promptIri = handle.iri.entity('skill', 'mcp-test/triage');
        expect(objectValues(imported, promptIri, SCHEMA.name)).toEqual(['Triage-Anleitung']);
        expect(objectValues(imported, promptIri, OW.trigger)).toEqual(['Wenn ein Ticket einzuordnen ist.']);
        expect(objectValues(imported, providerIri, OW.providesSkill)).toEqual([promptIri]);
    });

    it('erkennt ein unverändertes Inventar als No-Op und Änderungen als Replace', async () => {
        await createConnector(handle, { id: 'mcp-noop', name: 'N', kind: 'mcp-server', locator: MCP_URL });
        expect((await syncConnector(handle, 'mcp-noop', { fetchImpl, now: fixedClock() })).status).toBe('imported');
        expect((await syncConnector(handle, 'mcp-noop', { fetchImpl, now: fixedClock() })).status).toBe('noop');

        routes.set(MCP_URL, mcpStubRoute({
            ...inventory,
            tools: [{ name: 'renamed', inputSchema: { type: 'object' } }],
        }));
        const third = await syncConnector(handle, 'mcp-noop', { fetchImpl, now: fixedClock() });
        expect(third.status).toBe('imported');
        const imported = await dumpGraph(handle, handle.iri.importGraph('mcp-noop'));
        const toolNames = imported
            .filter(q => q.predicate.value === DCTERMS.identifier && q.subject.value.includes('/tool/'))
            .map(q => q.object.value);
        expect(toolNames).toEqual(['renamed']);
    });

    it('importiert einen Prompts-only-Server ehrlich ohne Tools', async () => {
        routes.set(MCP_URL, mcpStubRoute({
            serverInfo: { name: 'prompts-only', version: '1' },
            prompts: [{ name: 'brainstorm', description: 'Ideen sammeln.' }],
        }));
        await createConnector(handle, { id: 'mcp-po', name: 'P', kind: 'mcp-server', locator: MCP_URL });
        const result = await syncConnector(handle, 'mcp-po', { fetchImpl, now: fixedClock() });
        expect(result.status).toBe('imported');
        const imported = await dumpGraph(handle, handle.iri.importGraph('mcp-po'));
        expect(imported.some(q => q.object.value === OW.Tool)).toBe(false);
        expect(objectValues(imported, handle.iri.entity('skill', 'mcp-po/brainstorm'), SCHEMA.name)).toEqual(['brainstorm']);
    });

    it('quarantäniert doppelte Tool-Namen statt doppelte Knoten zu bauen', async () => {
        routes.set(MCP_URL, mcpStubRoute({
            serverInfo: { name: 'dup', version: '1' },
            tools: [
                { name: 'twice', inputSchema: { type: 'object' } },
                { name: 'twice', inputSchema: { type: 'object', properties: {} } },
            ],
        }));
        await createConnector(handle, { id: 'mcp-dup', name: 'D', kind: 'mcp-server', locator: MCP_URL });
        const result = await syncConnector(handle, 'mcp-dup', { fetchImpl, now: fixedClock() });
        expect(result.status).toBe('imported');
        expect(result.quarantined).toHaveLength(1);
        expect(result.quarantined[0].reason).toContain('Doppelter Tool-Name');
    });
});

// ---------------------------------------------------------------------------
// AI-Spiegel (graph/meta)
// ---------------------------------------------------------------------------

describe('AI-Spiegel in graph/meta (M9)', () => {
    let handle: GraphHandle;

    beforeEach(() => {
        handle = { store: new OxigraphStore(), iri: createIriFactory(INSTANCE_BASE) };
    });

    it('extrahiert [[TOOL:…]]-Referenzen dedupliziert und sortiert', () => {
        expect(referencedToolNames('Nutze [[TOOL:b:{"x":1}]] dann [[TOOL:a:{}]] und wieder [[TOOL:b:{}]].')).toEqual(['a', 'b']);
        expect(referencedToolNames('Kein Marker, nur Prosa über Tools.')).toEqual([]);
    });

    it('spiegelt nur aktivierte Einträge und ist deterministisch', () => {
        const key = (q: Quad) => `${q.subject.value}|${q.predicate.value}|${q.object.termType}|${q.object.value}`;
        const first = aiMirrorQuads(handle.iri, MIRROR_INPUT);
        const second = aiMirrorQuads(handle.iri, MIRROR_INPUT);
        expect(second.map(key)).toEqual(first.map(key));

        const subjects = new Set(first.map(q => q.subject.value));
        expect(subjects.has(handle.iri.entity('skill', 'skill-inaktiv'))).toBe(false);
        expect(subjects.has(handle.iri.entity('agent', 'agent-aus'))).toBe(false);
        expect(subjects.has(handle.iri.entity('tool', 'api-aus'))).toBe(false);
        expect(subjects.has(handle.iri.entity('tool', 'workspace_finder'))).toBe(true);
        expect(subjects.has(handle.iri.entity('tool', 'use_skill'))).toBe(true);
        expect(subjects.has(handle.iri.entity('tool-provider', 'mcp-srv1'))).toBe(true);
    });

    it('ersetzt nur den eigenen Abschnitt und lässt die Connector-Registry stehen', async () => {
        await createConnector(handle, { id: 'reg-bleibt', name: 'Registry', kind: 'rdf-file', locator: 'https://example.org/x.ttl' });
        const first = await replaceAiMirror(handle, MIRROR_INPUT);
        expect(first.changed).toBe(true);
        // Idempotent: unveränderter Input ⇒ kein Schreiben.
        const second = await replaceAiMirror(handle, MIRROR_INPUT);
        expect(second.changed).toBe(false);

        // Mutierter Input: der Spiegel folgt, die Registry bleibt.
        const third = await replaceAiMirror(handle, { ...MIRROR_INPUT, skills: [] });
        expect(third.changed).toBe(true);
        const meta = await dumpGraph(handle, handle.iri.sharedGraph('meta'));
        expect(meta.some(q => q.subject.value === handle.iri.entity('connector', 'reg-bleibt'))).toBe(true);
        expect(meta.some(q => q.subject.value === handle.iri.entity('skill', 'skill-wetterbericht'))).toBe(false);
        expect(meta.some(q => q.subject.value === handle.iri.entity('agent', 'agent-recherche'))).toBe(true);
    });

    it('M9-Abnahme: SPARQL beantwortet, welche Skills welche Tools benötigen und wer sie anbietet', async () => {
        await replaceAiMirror(handle, MIRROR_INPUT);

        // Frage 1: Skill → benötigtes Tool → Anbieter des Tools.
        const needs = await selectAll(handle, `
            SELECT ?skillName ?toolId ?providerName WHERE {
                GRAPH <${handle.iri.sharedGraph('meta')}> {
                    ?skill a ow:Skill ; schema:name ?skillName ; ow:requiresTool ?tool .
                    ?tool dcterms:identifier ?toolId ; ow:providedBy ?provider .
                    ?provider schema:name ?providerName .
                }
            } ORDER BY ?toolId
        `);
        expect(needs).toEqual([
            { skillName: 'Wetterbericht', toolId: 'api-wetter', providerName: 'Open Workspace' },
            { skillName: 'Wetterbericht', toolId: 'workspace_finder', providerName: 'Open Workspace' },
        ]);

        // Frage 2: Wer bietet welche Skills an (nativer Spiegel)?
        const offers = await selectAll(handle, `
            SELECT ?agentName ?skillName WHERE {
                GRAPH <${handle.iri.sharedGraph('meta')}> {
                    ?agent ow:providesSkill ?skill ; schema:name ?agentName .
                    ?skill schema:name ?skillName .
                }
            } ORDER BY ?skillName
        `);
        expect(offers).toEqual([
            { agentName: 'Remote-Recherche', skillName: 'Web-Recherche' },
            { agentName: 'Remote-Recherche', skillName: 'Zusammenfassen' },
        ]);
    });

    it('M9-Abnahme über alle Quellen: Spiegel + a2a-Import + mcp-Import in einem Store', async () => {
        const routes = new Map<string, Route>();
        const log: string[] = [];
        const fetchImpl = makeFetchStub(routes, log);
        routes.set(CARD_URL, jsonResponse(AGENT_CARD));
        routes.set(MCP_URL, mcpStubRoute({
            serverInfo: { name: 'stub-mcp', version: '1.2.3' },
            tools: [{ name: 'search', description: 'Suche.', inputSchema: { type: 'object' } }],
            prompts: [{ name: 'triage', description: 'Ticket einordnen.' }],
        }));

        await replaceAiMirror(handle, MIRROR_INPUT);
        await createConnector(handle, { id: 'a2a-x', name: 'A2A', kind: 'a2a-agent-card', locator: AGENT_ORIGIN });
        await createConnector(handle, { id: 'mcp-x', name: 'MCP', kind: 'mcp-server', locator: MCP_URL });
        expect((await syncConnector(handle, 'a2a-x', { fetchImpl, now: fixedClock() })).status).toBe('imported');
        expect((await syncConnector(handle, 'mcp-x', { fetchImpl, now: fixedClock() })).status).toBe('imported');

        // EINE Query über alle Graphen: jeder Anbieter (Agent im
        // foaf-Sinn — Persona, A2A-Agent oder MCP-Server) mit seinen Skills.
        const rows = await selectAll(handle, `
            SELECT DISTINCT ?agentName ?skillName WHERE {
                GRAPH ?g { ?agent ow:providesSkill ?skill ; schema:name ?agentName . }
                GRAPH ?g2 { ?skill schema:name ?skillName . }
            } ORDER BY ?agentName ?skillName
        `);
        expect(rows).toEqual([
            { agentName: 'Recherche-Agent', skillName: 'Web-Recherche' },
            { agentName: 'Recherche-Agent', skillName: 'Zusammenfassen' },
            { agentName: 'Remote-Recherche', skillName: 'Web-Recherche' },
            { agentName: 'Remote-Recherche', skillName: 'Zusammenfassen' },
            { agentName: 'stub-mcp', skillName: 'triage' },
        ]);

        // Werkzeugbedarf und -angebot über Spiegel UND Import hinweg.
        const tools = await selectAll(handle, `
            SELECT DISTINCT ?toolId ?providerName WHERE {
                GRAPH ?g { ?tool a ow:Tool ; dcterms:identifier ?toolId ; ow:providedBy ?provider . }
                GRAPH ?g2 { ?provider schema:name ?providerName . }
            } ORDER BY ?toolId
        `);
        expect(tools).toEqual([
            { toolId: 'api-wetter', providerName: 'Open Workspace' },
            { toolId: 'search', providerName: 'stub-mcp' },
            { toolId: 'use_skill', providerName: 'Open Workspace' },
            { toolId: 'workspace_finder', providerName: 'Open Workspace' },
        ]);
    });
});
