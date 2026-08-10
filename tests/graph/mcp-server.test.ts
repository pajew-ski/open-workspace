// @vitest-environment node
/**
 * M10-Abnahme MCP-Server (GRAPH_CORE_SPEC §7.6, §13):
 *
 *  1. Ein **externer MCP-Client** verbindet sich, ruft `graph_retrieve` auf
 *     und erhält Kontext **mit Provenienz**. Der Client ist der echte
 *     SDK-Client über Streamable HTTP — dasselbe Protokoll, das Claude
 *     Desktop oder ein zweiter Workspace spricht; nur der Transportweg
 *     (fetch → Route-Handler) ist im Test kurzgeschlossen.
 *  2. **Negativtest**: Ein Token ohne Leserecht auf einen Graphen sieht
 *     dessen Knoten auch über mehrere Hops nicht — der Seed liegt im
 *     erlaubten Graphen und führt über eine Kante in den gesperrten.
 *     Geprüft über ALLE Pfade: retrieve, neighbors, describe, search,
 *     sparql und die Resource `graph://<iri>`.
 *  3. Werkzeug-Inventar folgt dem Recht des Tokens (kein totes Werkzeug):
 *     `graph_sparql` nur mit SPARQL-Recht, `graph_write` nur mit
 *     Schreibfreigabe — Default aus (§7.6).
 *  4. Resources (`graph://<iri>`, Turtle + JSON-LD) und Prompts
 *     (gespeicherte Retrieval-Profile aus M8).
 *  5. Zugangsschutz: ohne Token 401, unbekanntes Token 401, ohne
 *     Konfiguration 503, fremde Session-ID 404, Rate-Limit 429.
 *  6. `graph_write` schreibt ausschließlich in den freigegebenen Graphen,
 *     mit `prov:wasAttributedTo` auf den aufrufenden Agenten.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Quad } from '@rdfjs/types';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OxigraphStore } from '@/lib/graph/store/oxigraph';
import { createIriFactory } from '@/lib/graph/iri';
import { factory, literal, namedNode, typedLiteral } from '@/lib/graph/rdf';
import { DCTERMS, OW, PROV, RDF, SCHEMA, SKOS } from '@/lib/graph/vocab';
import { buildFulltextIndexForGraphs, type GraphHandle } from '@/lib/graph/search/retrieval';
import { createRetrievalProfile } from '@/lib/graph/search/profiles';
import { parseRdf } from '@/lib/graph/serialize/io';
import { McpHost } from '@/lib/graph/mcp/http';
import { parseMcpTokens, grantForToken, MCP_TOKENS_ENV } from '@/lib/graph/mcp/tokens';
import { ensureDefaultAuthorizations, setAuthorization } from '@/lib/graph/authz/acl-graph';
import { toolsForGrant } from '@/lib/graph/mcp/server';
import { graphResourceUri } from '@/lib/graph/mcp/tools';
import { RateLimiter } from '@/lib/graph/mcp/limits';

const INSTANCE_BASE = 'urn:ow:11111111-2222-4333-8444-555555555555:';
const iri = createIriFactory(INSTANCE_BASE);
const nn = namedNode;

const WORKSPACE = nn(iri.graph('workspace'));
/** Der gesperrte Graph des Negativtests (Import eines Connectors). */
const SECRET_GRAPH = nn(iri.importGraph('geheim'));

const doc = (id: string) => iri.entity('doc', id);
const tag = (id: string) => iri.entity('tag', id);

const OPEN_TOKEN = 'token-offen-0123456789abcdef';
const NARROW_TOKEN = 'token-eng-0123456789abcdef';
const WRITER_TOKEN = 'token-schreiber-0123456789ab';

const TOKEN_CONFIG = JSON.stringify([
    { id: 'voll', label: 'Voller Lesezugriff', token: OPEN_TOKEN, scopes: ['workspace', 'public', 'meta', 'import/*'], sparql: true },
    { id: 'eng', label: 'Nur Workspace', token: NARROW_TOKEN, scopes: ['workspace', 'meta'], sparql: true },
    { id: 'schreiber', token: WRITER_TOKEN, scopes: ['workspace', 'shared/*'], write: true, writeScope: 'shared/agenten' },
]);

/**
 * Wissensgraph des Tests:
 *
 *   graph/<u>/workspace       doc-oeffentlich —ow:linksTo→ doc-brücke
 *                             doc-brücke      —ow:linksTo→ doc-geheim (!)
 *                             doc-oeffentlich —schema:about→ tag-thema
 *   graph/<u>/import/geheim   doc-geheim (Titel, Text, Verweis zurück)
 *
 * Die Kante doc-brücke → doc-geheim liegt im ERLAUBTEN Graphen; nur der
 * Knoten selbst lebt im gesperrten. Genau das ist der Leak-Pfad, den §7.6
 * verlangt zu schließen: ein Nachfilter würde die Kante durchlassen.
 */
function buildQuads(): Quad[] {
    const quads: Quad[] = [];
    const add = (s: string, p: string, o: Parameters<typeof factory.quad>[2], g = WORKSPACE) =>
        quads.push(factory.quad(nn(s), nn(p), o, g));

    add(doc('oeffentlich'), RDF.type, nn(OW.Document));
    add(doc('oeffentlich'), SCHEMA.name, literal('Offene Notiz über Graphen'));
    add(doc('oeffentlich'), SCHEMA.text, literal('Diese Notiz erklärt Wissensgraphen und Retrieval.'));
    add(doc('oeffentlich'), DCTERMS.created, typedLiteral.dateTime('2026-08-01T10:00:00.000Z'));
    add(doc('oeffentlich'), OW.linksTo, nn(doc('bruecke')));
    add(doc('oeffentlich'), SCHEMA.about, nn(tag('thema')));

    add(doc('bruecke'), RDF.type, nn(OW.Document));
    add(doc('bruecke'), SCHEMA.name, literal('Brückennotiz'));
    add(doc('bruecke'), SCHEMA.text, literal('Verbindet die offene Notiz mit weiterem Material.'));
    add(doc('bruecke'), DCTERMS.created, typedLiteral.dateTime('2026-08-02T10:00:00.000Z'));
    // Die verbotene Kante: Ziel liegt im gesperrten Graphen.
    add(doc('bruecke'), OW.linksTo, nn(doc('geheim')));

    add(tag('thema'), RDF.type, nn(SKOS.Concept));
    add(tag('thema'), SKOS.prefLabel, literal('Wissensgraph'));

    // Gesperrter Import-Graph.
    add(doc('geheim'), RDF.type, nn(OW.Document), SECRET_GRAPH);
    add(doc('geheim'), SCHEMA.name, literal('Streng vertrauliche Verschlusssache'), SECRET_GRAPH);
    add(doc('geheim'), SCHEMA.text, literal('Der geheime Inhalt nennt Wissensgraphen und Retrieval.'), SECRET_GRAPH);
    add(doc('geheim'), OW.linksTo, nn(doc('oeffentlich')), SECRET_GRAPH);

    return quads;
}

interface Harness {
    handle: GraphHandle;
    host: McpHost;
    /** fetch, das direkt in den Host läuft (statt über das Netz). */
    fetchImpl: (url: string | URL, init?: RequestInit) => Promise<Response>;
    clock: { value: number };
}

async function createHarness(options: { tokens?: string; capable?: boolean } = {}): Promise<Harness> {
    const store = new OxigraphStore();
    const handle: GraphHandle = { store, iri };
    for (const graph of [WORKSPACE, SECRET_GRAPH]) {
        await store.load(buildQuads().filter(q => q.graph.value === graph.value), graph);
    }
    // Kern-Shapes wie beim Serverstart nach graph/shapes — graph_write
    // validiert dagegen (SPEC §7.2, erste der drei Stellen).
    await store.load(
        parseRdf(readFileSync(path.join(process.cwd(), 'ontology', 'shapes', 'core.ttl'), 'utf8'), { format: 'text/turtle' }),
        nn(iri.sharedGraph('shapes')),
        { replace: true },
    );
    // Rechte sind seit M13 Daten (SPEC §17.2): ohne Regeln in graph/acl
    // sieht auch der Eigentümer nichts. Der Serverstart legt genau diese
    // Standardregeln an — der Test tut dasselbe.
    await ensureDefaultAuthorizations(handle, {
        admins: ['default'],
        additionalGraphs: [iri.graph('public'), iri.spaceGraph('agenten')],
    });
    await setAuthorization(handle, {
        graph: iri.spaceGraph('agenten'),
        principal: { kind: 'user', id: 'default' },
        modes: ['control'],
    });
    await createRetrievalProfile(handle, {
        id: 'nachbarschaft',
        name: 'Nachbarschaft',
        description: 'Zwei Hops rund um den Treffer.',
        config: { maxHops: 2, maxNodes: 20, format: 'context' },
    });

    const clock = { value: 1_000_000 };
    const host = new McpHost({
        graph: async () => handle,
        tokens: () => parseMcpTokens(options.tokens ?? TOKEN_CONFIG),
        capable: options.capable ?? true,
        retrievalDeps: async (h, dataset) => ({ fulltext: await buildFulltextIndexForGraphs(h, dataset) }),
        now: () => new Date('2026-08-09T12:00:00.000Z'),
        clock: () => clock.value,
        sessionId: (() => {
            let n = 0;
            return () => `session-${n += 1}`;
        })(),
    });

    const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
        const request = new Request(String(url), init as RequestInit);
        return host.handle(request);
    };
    return { handle, host, fetchImpl, clock };
}

async function connectClient(harness: Harness, token: string): Promise<Client> {
    const client = new Client({ name: 'externer-test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('https://workspace.test/api/mcp'), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        fetch: (input, init) => harness.fetchImpl(String(input), init),
    });
    await client.connect(transport);
    return client;
}

function textOf(result: unknown): string {
    const content = (result as { content?: unknown }).content;
    const parts = Array.isArray(content) ? content as Array<{ type: string; text?: string }> : [];
    return parts.filter(p => p.type === 'text').map(p => p.text ?? '').join('\n');
}

function jsonOf<T>(result: unknown): T {
    return JSON.parse(textOf(result)) as T;
}

/** Resource-Inhalte in der Textform (blob-Varianten kommen hier nicht vor). */
function textContents(result: { contents: unknown[] }): Array<{ mimeType?: string; text?: string }> {
    return result.contents as Array<{ mimeType?: string; text?: string }>;
}

interface RetrievePayload {
    nodes: Array<{ iri: string; score: number; hop: number; label?: string }>;
    edges: Array<{ s: string; p: string; o: string; graph: string }>;
    context?: string;
    provenance: Array<{ iri: string; sourceGraph: string; connector?: string }>;
    explain: { seedStrategy: string; hopsUsed: number };
}

const openClients: Client[] = [];
async function client(harness: Harness, token: string): Promise<Client> {
    const c = await connectClient(harness, token);
    openClients.push(c);
    return c;
}

afterEach(async () => {
    await Promise.all(openClients.splice(0).map(c => c.close().catch(() => undefined)));
});

describe('M10 — externer MCP-Client auf dem Graphen (SPEC §7.6)', () => {
    let harness: Harness;

    beforeAll(async () => {
        harness = await createHarness();
    });

    it('verbindet sich, sieht die Werkzeuge aus §7.6 und ruft graph_retrieve mit Provenienz ab', async () => {
        const external = await client(harness, OPEN_TOKEN);

        const { tools } = await external.listTools();
        expect(tools.map(t => t.name).sort()).toEqual([
            'graph_describe', 'graph_neighbors', 'graph_retrieve', 'graph_search', 'graph_sparql',
        ]);
        // graph_write ist per Default AUS (§7.6) — dieses Token hat es nicht.
        expect(tools.map(t => t.name)).not.toContain('graph_write');

        const result = await external.callTool({
            name: 'graph_retrieve',
            arguments: { seeds: { iri: [doc('oeffentlich')] }, maxHops: 2, format: 'both' },
        });
        expect(result.isError).toBeFalsy();
        const payload = jsonOf<RetrievePayload>(result);

        // Kontext ist zitierfähig und enthält den Seed.
        expect(payload.context).toContain('[1]');
        expect(payload.context).toContain('Offene Notiz über Graphen');
        // Provenienz ist Pflicht — jeder Knoten weist seinen Quell-Graphen aus.
        expect(payload.provenance.length).toBe(payload.nodes.length);
        const provenanceOfSeed = payload.provenance.find(p => p.iri === doc('oeffentlich'));
        expect(provenanceOfSeed?.sourceGraph).toBe(iri.graph('workspace'));
        // Der Import-Knoten ist für dieses Token sichtbar und trägt seinen Connector.
        const secret = payload.provenance.find(p => p.iri === doc('geheim'));
        expect(secret?.connector).toBe('geheim');
        expect(payload.explain.seedStrategy).toContain('iri');
        expect(payload.explain.hopsUsed).toBeGreaterThan(0);
    });

    it('liefert Knoten als Resource graph://<iri> in Turtle und JSON-LD', async () => {
        const external = await client(harness, OPEN_TOKEN);

        const listed = await external.listResources();
        expect(listed.resources.some(r => r.uri === graphResourceUri(doc('oeffentlich')))).toBe(true);

        const read = await external.readResource({ uri: graphResourceUri(doc('oeffentlich')) });
        const contents = textContents(read);
        expect(contents.map(c => c.mimeType).sort()).toEqual(['application/ld+json', 'text/turtle']);
        const turtle = contents.find(c => c.mimeType === 'text/turtle')?.text as string;
        expect(turtle).toContain('Offene Notiz über Graphen');
        const jsonld = JSON.parse(contents.find(c => c.mimeType === 'application/ld+json')?.text as string);
        expect(jsonld['@id']).toBe(doc('oeffentlich'));
        expect(jsonld[SCHEMA.name]).toBe('Offene Notiz über Graphen');
    });

    it('exponiert gespeicherte Retrieval-Profile als Prompts', async () => {
        const external = await client(harness, OPEN_TOKEN);

        const { prompts } = await external.listPrompts();
        expect(prompts.map(p => p.name)).toContain('retrieval_nachbarschaft');

        const prompt = await external.getPrompt({ name: 'retrieval_nachbarschaft', arguments: { query: 'Wissensgraphen' } });
        const text = prompt.messages.map(m => (m.content as { text?: string }).text ?? '').join('\n');
        expect(text).toContain('Nachbarschaft');
        expect(text).toContain('Offene Notiz über Graphen');
    });

    it('beantwortet graph_search, graph_neighbors und graph_describe mit Quell-Graphen', async () => {
        const external = await client(harness, OPEN_TOKEN);

        const search = jsonOf<{ hits: Array<{ iri: string; label: string | null }> }>(
            await external.callTool({ name: 'graph_search', arguments: { query: 'Wissensgraphen' } }));
        expect(search.hits.map(h => h.iri)).toContain(doc('oeffentlich'));

        const neighbors = jsonOf<{ neighbors: Array<{ iri: string; predicate: string; direction: string }> }>(
            await external.callTool({ name: 'graph_neighbors', arguments: { iri: doc('oeffentlich') } }));
        expect(neighbors.neighbors).toContainEqual(expect.objectContaining({
            iri: doc('bruecke'), predicate: OW.linksTo, direction: 'out',
        }));

        const described = jsonOf<{ found: boolean; turtle: string; provenance: Array<{ graph: string; connector?: string }> }>(
            await external.callTool({ name: 'graph_describe', arguments: { iri: doc('geheim') } }));
        expect(described.found).toBe(true);
        expect(described.provenance[0].connector).toBe('geheim');
    });

    it('führt graph_sparql read-only aus und lehnt Updates ab', async () => {
        const external = await client(harness, OPEN_TOKEN);

        const ok = await external.callTool({
            name: 'graph_sparql',
            arguments: { query: `SELECT ?n WHERE { <${doc('oeffentlich')}> <${SCHEMA.name}> ?n }` },
        });
        expect(ok.isError).toBeFalsy();
        expect(textOf(ok)).toContain('Offene Notiz über Graphen');

        const update = await external.callTool({
            name: 'graph_sparql',
            arguments: { query: `INSERT DATA { GRAPH <${iri.graph('workspace')}> { <${doc('x')}> <${SCHEMA.name}> "X" } }` },
        });
        expect(update.isError).toBe(true);
        expect(textOf(update)).toContain('read-only');
    });
});

describe('M10 — Negativtest: gesperrter Graph bleibt auch über Hops unsichtbar', () => {
    let harness: Harness;

    beforeAll(async () => {
        harness = await createHarness();
    });

    it('führt einen Seed über eine erlaubte Kante NICHT in den gesperrten Graphen', async () => {
        const external = await client(harness, NARROW_TOKEN);

        const payload = jsonOf<RetrievePayload>(await external.callTool({
            name: 'graph_retrieve',
            // Vier Hops: die Kante doc-bruecke → doc-geheim liegt im
            // erlaubten Graphen und wäre ohne Dataset-Klammer traversierbar.
            arguments: { seeds: { iri: [doc('oeffentlich')] }, maxHops: 4, maxNodes: 100, format: 'both' },
        }));

        expect(payload.nodes.map(n => n.iri)).toContain(doc('bruecke'));
        expect(payload.nodes.map(n => n.iri)).not.toContain(doc('geheim'));
        expect(payload.provenance.map(p => p.sourceGraph)).not.toContain(SECRET_GRAPH.value);
        expect(payload.edges.every(e => e.graph !== SECRET_GRAPH.value)).toBe(true);
        expect(payload.context ?? '').not.toContain('Verschlusssache');
    });

    it('verschweigt den gesperrten Knoten auf allen übrigen Pfaden', async () => {
        const external = await client(harness, NARROW_TOKEN);

        const search = jsonOf<{ hits: Array<{ iri: string }> }>(await external.callTool({
            name: 'graph_search', arguments: { query: 'Verschlusssache' },
        }));
        expect(search.hits).toHaveLength(0);

        const neighbors = jsonOf<{ neighbors: unknown[]; sourceGraphs: string[] }>(await external.callTool({
            name: 'graph_neighbors', arguments: { iri: doc('geheim') },
        }));
        expect(neighbors.neighbors.filter(n => (n as { graph: string }).graph === SECRET_GRAPH.value)).toHaveLength(0);
        expect(neighbors.sourceGraphs).not.toContain(SECRET_GRAPH.value);

        const described = jsonOf<{ found: boolean; turtle: string }>(await external.callTool({
            name: 'graph_describe', arguments: { iri: doc('geheim') },
        }));
        expect(described.found).toBe(false);
        expect(described.turtle).toBe('');

        // Auch eine handgeschriebene SPARQL-Query mit explizitem GRAPH sieht nichts.
        const sparql = await external.callTool({
            name: 'graph_sparql',
            arguments: { query: `SELECT ?n WHERE { GRAPH <${SECRET_GRAPH.value}> { ?s <${SCHEMA.name}> ?n } }` },
        });
        expect(textOf(sparql)).not.toContain('Verschlusssache');

        // Und die Resource antwortet leer statt mit einer Existenzbestätigung.
        const resource = await external.readResource({ uri: graphResourceUri(doc('geheim')) });
        expect(textContents(resource).every(c => c.text === '')).toBe(true);
    });
});

describe('M10 — Zugangsschutz, Sitzungen und Rate-Limits (SPEC §7.6)', () => {
    it('lehnt Anfragen ohne und mit unbekanntem Token ab', async () => {
        const harness = await createHarness();
        const initialize = {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify({
                jsonrpc: '2.0', id: 1, method: 'initialize',
                params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
            }),
        };

        const anonymous = await harness.fetchImpl('https://workspace.test/api/mcp', initialize);
        expect(anonymous.status).toBe(401);
        expect(anonymous.headers.get('WWW-Authenticate')).toContain('Bearer');

        const wrong = await harness.fetchImpl('https://workspace.test/api/mcp', {
            ...initialize,
            headers: { ...initialize.headers, authorization: 'Bearer voellig-falsches-token-xyz' },
        });
        expect(wrong.status).toBe(401);
    });

    it('ist ohne konfigurierte Tokens ehrlich aus (503 statt offen)', async () => {
        const harness = await createHarness({ tokens: '' });
        const response = await harness.fetchImpl('https://workspace.test/api/mcp', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer irgendwas-langes-genug' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        });
        expect(response.status).toBe(503);
        expect(await response.text()).toContain(MCP_TOKENS_ENV);
    });

    it('meldet die Runtime ehrlich, wenn sie keinen MCP-Server hat', async () => {
        const harness = await createHarness({ capable: false });
        const response = await harness.fetchImpl('https://workspace.test/api/mcp', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${OPEN_TOKEN}` },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        });
        expect(response.status).toBe(503);
        expect(await response.text()).toContain('capabilities.mcpServer');
    });

    it('bindet Sitzungen an ihr Token — eine fremde Session-ID ist unbekannt', async () => {
        const harness = await createHarness();
        const external = await client(harness, OPEN_TOKEN);
        expect(harness.host.sessionCount).toBe(1);

        const stolen = await harness.fetchImpl('https://workspace.test/api/mcp', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                authorization: `Bearer ${NARROW_TOKEN}`,
                'mcp-session-id': 'session-1',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
        });
        expect(stolen.status).toBe(404);
        await external.close();
    });

    it('greift beim Rate-Limit und gibt Retry-After zurück', async () => {
        const harness = await createHarness({
            tokens: JSON.stringify([{ id: 'knapp', token: OPEN_TOKEN, scopes: ['workspace'], rateLimitPerMinute: 2 }]),
        });
        const send = () => harness.fetchImpl('https://workspace.test/api/mcp', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${OPEN_TOKEN}` },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        });
        await send();
        await send();
        const blocked = await send();
        expect(blocked.status).toBe(429);
        expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);

        // Nach Ablauf des Fensters ist wieder Luft.
        harness.clock.value += 61_000;
        expect((await send()).status).not.toBe(429);
    });

    it('zählt das gleitende Fenster pro Token', () => {
        let now = 0;
        const limiter = new RateLimiter(() => now);
        expect(limiter.check('a', 2).allowed).toBe(true);
        expect(limiter.check('a', 2).allowed).toBe(true);
        expect(limiter.check('a', 2).allowed).toBe(false);
        // Anderes Token, eigenes Fenster.
        expect(limiter.check('b', 2).allowed).toBe(true);
        now += 60_001;
        expect(limiter.check('a', 2).allowed).toBe(true);
    });
});

describe('M10 — graph_write (Default aus, SPEC §7.6)', () => {
    it('schreibt nur in den freigegebenen Graphen, mit prov:wasAttributedTo', async () => {
        const harness = await createHarness();
        const writer = await client(harness, WRITER_TOKEN);

        const { tools } = await writer.listTools();
        expect(tools.map(t => t.name)).toContain('graph_write');
        // Dieses Token hat kein SPARQL-Recht — das Werkzeug existiert nicht.
        expect(tools.map(t => t.name)).not.toContain('graph_sparql');

        const written = jsonOf<{ graph: string; added: number; agent: string; activity: string }>(
            await writer.callTool({
                name: 'graph_write',
                arguments: {
                    rdf: `<${doc('vom-agenten')}> <${SCHEMA.name}> "Vom Agenten angelegt" .`,
                    format: 'text/turtle',
                },
            }));
        expect(written.graph).toBe(iri.spaceGraph('agenten'));
        expect(written.added).toBeGreaterThan(0);

        const quads: Quad[] = [];
        for await (const q of harness.handle.store.dump(nn(written.graph))) quads.push(q);
        expect(quads.some(q => q.subject.value === doc('vom-agenten') && q.object.value === 'Vom Agenten angelegt')).toBe(true);
        expect(quads.some(q =>
            q.subject.value === doc('vom-agenten') &&
            q.predicate.value === PROV.wasAttributedTo &&
            q.object.value === written.agent)).toBe(true);
        expect(quads.some(q => q.subject.value === written.activity && q.predicate.value === RDF.type && q.object.value === PROV.Activity)).toBe(true);

        // Der Workspace-Graph bleibt unberührt (kein zweites Schreibziel).
        const workspace: Quad[] = [];
        for await (const q of harness.handle.store.dump(WORKSPACE)) workspace.push(q);
        expect(workspace.some(q => q.subject.value === doc('vom-agenten'))).toBe(false);
    });
});

describe('M10 — Token-Konfiguration und Grant (SPEC §7.6)', () => {
    it('meldet Konfigurationsfehler, statt sie zu verschlucken', () => {
        expect(parseMcpTokens('kein json').errors[0]).toContain('kein gültiges JSON');
        expect(parseMcpTokens('{}').errors[0]).toContain('JSON-Liste');
        expect(parseMcpTokens('[{"id":"a","token":"kurz","scopes":["workspace"]}]').errors[0]).toContain('mindestens 16 Zeichen');
        expect(parseMcpTokens(`[{"id":"a","token":"${OPEN_TOKEN}","scopes":["workspace"],"write":true}]`).errors[0])
            .toContain('writeScope');
        const doubled = parseMcpTokens(`[
            {"id":"a","token":"${OPEN_TOKEN}","scopes":["workspace"]},
            {"id":"a","token":"${NARROW_TOKEN}","scopes":["workspace"]}
        ]`);
        expect(doubled.errors[0]).toContain('doppelt');
        expect(doubled.tokens).toHaveLength(1);
    });

    it('bildet Scope-Muster auf Graphen ab und lässt graph/acl nie zu', async () => {
        const harness = await createHarness();
        const existing = [
            iri.graph('workspace'),
            iri.graph('public'),
            iri.graph('presentation'),
            iri.importGraph('geheim'),
            iri.sharedGraph('meta'),
            iri.sharedGraph('acl'),
            iri.inferredGraph('workspace'),
        ];
        await ensureDefaultAuthorizations(harness.handle, { admins: ['default'], additionalGraphs: existing });
        const { tokens } = parseMcpTokens(TOKEN_CONFIG);
        const voll = (await grantForToken(tokens[0], harness.handle, existing)).grant;
        expect(voll.readableGraphs).toEqual([
            iri.sharedGraph('meta'),
            iri.importGraph('geheim'),
            iri.graph('public'),
            iri.graph('workspace'),
        ].sort());
        expect(voll.readableGraphs).not.toContain(iri.sharedGraph('acl'));
        expect(toolsForGrant(voll)).toContain('graph_sparql');

        const eng = (await grantForToken(tokens[1], harness.handle, existing)).grant;
        expect(eng.readableGraphs).not.toContain(iri.importGraph('geheim'));
        expect(eng.writableGraph).toBeNull();

        // Wildcard darf acl auch mit "*" nicht einsammeln.
        const wildcard = (await grantForToken(
            { ...tokens[0], scopes: ['*'] },
            harness.handle,
            existing,
        )).grant;
        expect(wildcard.readableGraphs).not.toContain(iri.sharedGraph('acl'));
        expect(wildcard.readableGraphs).toContain(iri.graph('presentation'));
    });

    it('verweigert Schreibziele außerhalb der Verengung und systemverwaltete Graphen', async () => {
        const harness = await createHarness();
        const existing = [iri.graph('workspace'), iri.sharedGraph('meta')];
        await ensureDefaultAuthorizations(harness.handle, { admins: ['default'], additionalGraphs: existing });

        // Syntaktisch gültiges Ziel, aber außerhalb der Token-Verengung:
        // kein Konfigurationsfehler, schlicht kein Schreibrecht (M13).
        const outside = await grantForToken(
            { id: 'x', token: OPEN_TOKEN, user: 'default', scopes: ['workspace'], sparql: false, write: true, writeScope: 'shared/fremd', rateLimitPerMinute: 60 },
            harness.handle, existing);
        expect(outside.grant.writableGraph).toBeNull();

        // Systemverwaltete Graphen sind gar kein gültiges Schreibziel.
        const system = await grantForToken(
            { id: 'y', token: OPEN_TOKEN, user: 'default', scopes: ['*'], sparql: false, write: true, writeScope: 'meta', rateLimitPerMinute: 60 },
            harness.handle, existing);
        expect(system.grant.writableGraph).toBeNull();
        expect(system.writeScopeError).toContain('Ungültiges writeScope');

        // Ohne ACL-Recht bleibt auch ein erlaubtes Muster wirkungslos.
        const noRule = await grantForToken(
            { id: 'z', token: OPEN_TOKEN, user: 'fremd', scopes: ['workspace'], sparql: false, write: true, writeScope: 'workspace', rateLimitPerMinute: 60 },
            harness.handle, existing);
        expect(noRule.grant.writableGraph).toBeNull();
        expect(noRule.grant.readableGraphs).toEqual([]);
    });
});

describe('M10 — SHACL auf dem Schreibpfad (SPEC §7.2)', () => {
    it('blockiert einen Schreibvorgang, der eine sh:Violation neu einführt', async () => {
        const harness = await createHarness();
        const writer = await client(harness, WRITER_TOKEN);

        const blocked = await writer.callTool({
            name: 'graph_write',
            // Eine Aufgabe ohne Titel verletzt owsh:TaskShape (sh:Violation).
            arguments: { rdf: `<${iri.entity('task', 'ohne-titel')}> a <${OW.Task}> .` },
        });
        expect(blocked.isError).toBe(true);
        expect(textOf(blocked)).toContain('SHACL-Verletzung');

        // Nichts davon ist im Zielgraphen gelandet.
        const quads: Quad[] = [];
        for await (const q of harness.handle.store.dump(nn(iri.spaceGraph('agenten')))) quads.push(q);
        expect(quads.some(q => q.subject.value === iri.entity('task', 'ohne-titel'))).toBe(false);
    });
});
