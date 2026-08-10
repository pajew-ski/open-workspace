// @vitest-environment node
/**
 * M13-Abnahme: die Test-Matrix aus GRAPH_CORE_SPEC §17.6.
 *
 * „Jede Zelle ist ein eigener Negativtest: Nutzer A hat keinen Lesezugriff
 * auf Graph G von Nutzer B. Für jeden Pfad ist nachzuweisen, dass A nichts
 * über den Inhalt von G erfährt — weder Tripel, noch Existenz, noch
 * Struktur."
 *
 * Aufbau (einmal für alle Zeilen):
 *
 *   Nutzer **bob** hat in `graph/u/bob/workspace` ein Geheimnis
 *   (`doc-geheim`, Titel „Vertrauliche Übernahmeplanung"). Nutzer
 *   **alice** hat in ihrem Workspace eine Notiz, die per `ow:linksTo`
 *   auf genau diesen Knoten zeigt — die **Kante liegt im erlaubten
 *   Graphen**, nur ihr Ziel nicht. Zusätzlich referenziert Alices
 *   Präsentations-Graph den fremden Knoten als Canvas-Karte, und im
 *   geteilten Raum `graph/shared/labor` liegt gemeinsames Material.
 *
 * Damit ist jeder Test unten ein echter Leak-Pfad, kein Strohmann: Ein
 * Nachfilter auf dem Ergebnis würde die Kante durchlassen, eine
 * Nachbarschafts-Expansion den Knoten aufnehmen, ein globaler Suchindex
 * das Literal finden.
 *
 * Die Zeilen der Matrix und ihre Tests:
 *   SPARQL SELECT · SPARQL DESCRIBE · SPARQL mit manipuliertem FROM ·
 *   SPARQL UPDATE · Multi-Hop-Retrieval · MCP graph_retrieve ·
 *   MCP graph_describe · MCP Resource graph://<iri> · Volltextsuche ·
 *   Vektorsuche · Inferenz-Graph · eingehende Föderation · ausgehende
 *   Föderation mit Bindings aus G · Export · Git-Sync ·
 *   Canvas-Referenz · Fehlermeldung existiert-nicht vs. gesperrt.
 */

import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Quad } from '@rdfjs/types';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OxigraphStore } from '@/lib/graph/store/oxigraph';
import { createIriFactory } from '@/lib/graph/iri';
import { factory, literal, namedNode } from '@/lib/graph/rdf';
import { OW, RDF, SCHEMA, SKOS } from '@/lib/graph/vocab';
import { executeSparqlProtocol, resolveDataset } from '@/lib/graph/sparql/protocol';
import { retrieve, retrievalDataset, buildFulltextIndexForGraphs, type GraphHandle } from '@/lib/graph/search/retrieval';
import { buildVectorIndex, type EmbeddingProvider } from '@/lib/graph/search/vector';
import { embeddingTextForNode } from '@/lib/graph/search/vector';
import { runReasoning } from '@/lib/graph/reasoning/run';
import { ensureDefaultAuthorizations, setAuthorization } from '@/lib/graph/authz/acl-graph';
import { grantForIdentity, snapshotExportRefusal, ANONYMOUS_IDENTITY } from '@/lib/graph/authz/resolve';
import { exportScopeFor } from '@/lib/graph/workspace/export';
import { McpHost } from '@/lib/graph/mcp/http';
import { parseMcpTokens } from '@/lib/graph/mcp/tokens';
import { graphResourceUri } from '@/lib/graph/mcp/tools';
import { FederationEndpointHost } from '@/lib/graph/federation/inbound';
import { createFederatedEndpoint } from '@/lib/graph/federation/registry';
import { planFederatedQuery } from '@/lib/graph/federation/service';
import type { AccessGrant } from '@/lib/graph/authz/grant';

const INSTANCE_BASE = 'https://ws.example.org/id/';
const alice = createIriFactory(INSTANCE_BASE, 'alice');
const bob = createIriFactory(INSTANCE_BASE, 'bob');
const nn = namedNode;

const SECRET_TITLE = 'Vertrauliche Übernahmeplanung';
const SECRET_TEXT = 'Codewort Nordlicht, Abschluss im November.';
const SECRET_DOC = bob.entity('doc', 'geheim');
const ALICE_DOC = alice.entity('doc', 'notiz');
const SHARED_DOC = `${INSTANCE_BASE}u/alice/doc/gemeinsam`;
const MISSING_DOC = alice.entity('doc', 'gibtsnicht');

const ALICE_TOKEN = 'token-alice-0123456789abcdef';
const BOB_TOKEN = 'token-bob-0123456789abcdefxx';

const TOKEN_CONFIG = JSON.stringify([
    { id: 'alice', token: ALICE_TOKEN, user: 'alice', sparql: true },
    { id: 'bob', token: BOB_TOKEN, user: 'bob', sparql: true },
]);

interface Fixture {
    store: OxigraphStore;
    aliceHandle: GraphHandle;
    bobHandle: GraphHandle;
    aliceGrant: AccessGrant;
    bobGrant: AccessGrant;
}

async function loadGraph(store: OxigraphStore, graph: string, quads: Quad[]): Promise<void> {
    await store.load(quads, nn(graph), { replace: true });
}

async function fixture(): Promise<Fixture> {
    const store = new OxigraphStore();
    const q = (s: string, p: string, o: Parameters<typeof factory.quad>[2], g: string) =>
        factory.quad(nn(s), nn(p), o, nn(g));

    // Bobs Geheimnis.
    await loadGraph(store, bob.graph('workspace'), [
        q(SECRET_DOC, RDF.type, nn(OW.Document), bob.graph('workspace')),
        q(SECRET_DOC, SCHEMA.name, literal(SECRET_TITLE), bob.graph('workspace')),
        q(SECRET_DOC, SCHEMA.text, literal(SECRET_TEXT), bob.graph('workspace')),
        q(SECRET_DOC, SKOS.broader, nn(bob.entity('tag', 'strategie')), bob.graph('workspace')),
    ]);

    // Alices Notiz — mit der Kante IN den gesperrten Graphen.
    await loadGraph(store, alice.graph('workspace'), [
        q(ALICE_DOC, RDF.type, nn(OW.Document), alice.graph('workspace')),
        q(ALICE_DOC, SCHEMA.name, literal('Alices Notiz'), alice.graph('workspace')),
        q(ALICE_DOC, OW.linksTo, nn(SECRET_DOC), alice.graph('workspace')),
    ]);

    // Alices Pinnwand referenziert den fremden Knoten (Canvas-Zeile).
    await loadGraph(store, alice.graph('presentation'), [
        q(alice.entity('canvas-node', 'karte-1'), RDF.type, nn(OW.CanvasNode), alice.graph('presentation')),
        q(alice.entity('canvas-node', 'karte-1'), OW.rendersNode, nn(SECRET_DOC), alice.graph('presentation')),
    ]);

    // Geteilter Raum, in dem beide arbeiten.
    await loadGraph(store, alice.spaceGraph('labor'), [
        q(SHARED_DOC, RDF.type, nn(OW.Document), alice.spaceGraph('labor')),
        q(SHARED_DOC, SCHEMA.name, literal('Gemeinsames Material'), alice.spaceGraph('labor')),
    ]);

    const handle = { store, iri: alice };
    await ensureDefaultAuthorizations(handle, { admins: ['alice'], spaceOwners: new Map([['labor', 'alice']]) });
    await setAuthorization(handle, {
        graph: alice.spaceGraph('labor'), principal: { kind: 'user', id: 'bob' }, modes: ['read', 'append'],
    });

    const aliceHandle: GraphHandle = { store, iri: alice };
    const bobHandle: GraphHandle = { store, iri: bob };
    return {
        store,
        aliceHandle,
        bobHandle,
        aliceGrant: await grantForIdentity(aliceHandle, { userId: 'alice', groups: [], authenticated: true }, { sparql: true }),
        bobGrant: await grantForIdentity(bobHandle, { userId: 'bob', groups: [], authenticated: true }, { sparql: true }),
    };
}

/** Ein Ergebnis darf das Geheimnis in KEINER Form enthalten. */
function expectNoLeak(payload: unknown): void {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    expect(text).not.toContain(SECRET_TITLE);
    expect(text).not.toContain(SECRET_TEXT);
    expect(text).not.toContain('Nordlicht');
}

let fx: Fixture;
beforeEach(async () => {
    fx = await fixture();
});

describe('M13 §17.6 — Grundlage: getrennte Nutzergraphen', () => {
    it('gibt jedem Nutzer genau seine Graphen plus den geteilten Raum', () => {
        expect(fx.aliceGrant.readableGraphs).toContain(alice.graph('workspace'));
        expect(fx.aliceGrant.readableGraphs).toContain(alice.spaceGraph('labor'));
        expect(fx.aliceGrant.readableGraphs).not.toContain(bob.graph('workspace'));

        expect(fx.bobGrant.readableGraphs).toContain(bob.graph('workspace'));
        expect(fx.bobGrant.readableGraphs).toContain(alice.spaceGraph('labor'));
        expect(fx.bobGrant.readableGraphs).not.toContain(alice.graph('workspace'));

        // Der geteilte Raum ist für Bob „beitragen", nicht „bearbeiten".
        expect(fx.bobGrant.appendableGraphs).toContain(alice.spaceGraph('labor'));
        expect(fx.bobGrant.writableGraphs).not.toContain(alice.spaceGraph('labor'));

        // graph/acl trifft kein Grant, auch nicht der des Verwalters.
        expect(fx.aliceGrant.readableGraphs).not.toContain(alice.sharedGraph('acl'));
        expect(fx.aliceGrant.controlGraphs).not.toContain(alice.sharedGraph('acl'));
    });
});

describe('M13 §17.6 — SPARQL', () => {
    async function query(sparql: string, grant = fx.aliceGrant, accept = 'application/sparql-results+json') {
        return executeSparqlProtocol(fx.store, alice, { method: 'POST', contentType: 'application/sparql-query', body: sparql, accept }, {
            allowedGraphs: grant.readableGraphs,
            writableGraphs: grant.writableGraphs ?? [],
        });
    }

    it('SELECT: findet Bobs Literale nicht', async () => {
        const response = await query('SELECT ?s ?p ?o WHERE { ?s ?p ?o }');
        expect(response.status).toBe(200);
        expectNoLeak(response.body);
        // Gegenprobe: Bob selbst sieht sein Dokument sehr wohl.
        const bobs = await query('SELECT ?s ?p ?o WHERE { ?s ?p ?o }', fx.bobGrant);
        expect(bobs.body).toContain(SECRET_TITLE);
    });

    it('DESCRIBE: liefert für einen fremden Knoten nichts', async () => {
        const response = await query(`DESCRIBE <${SECRET_DOC}>`, fx.aliceGrant, 'text/turtle');
        expect(response.status).toBe(200);
        expectNoLeak(response.body);
    });

    it('manipuliertes FROM: das Dataset wird injiziert, nicht ergänzt', async () => {
        const response = await query(
            `SELECT ?o FROM <${bob.graph('workspace')}> FROM <${alice.graph('workspace')}> WHERE { ?s <${SCHEMA.name}> ?o }`,
        );
        expect(response.status).toBe(200);
        expectNoLeak(response.body);
        expect(response.body).toContain('Alices Notiz');
    });

    it('UPDATE: kann fremde Graphen weder ändern noch anlegen', async () => {
        const insert = await executeSparqlProtocol(fx.store, alice, {
            method: 'POST',
            contentType: 'application/sparql-update',
            body: `INSERT DATA { GRAPH <${bob.graph('workspace')}> { <urn:x> <urn:y> "z" } }`,
        }, { allowedGraphs: fx.aliceGrant.readableGraphs, writableGraphs: fx.aliceGrant.writableGraphs ?? [] });
        expect(insert.status).toBe(403);

        const drop = await executeSparqlProtocol(fx.store, alice, {
            method: 'POST',
            contentType: 'application/sparql-update',
            body: `DROP GRAPH <${bob.graph('workspace')}>`,
        }, { allowedGraphs: fx.aliceGrant.readableGraphs, writableGraphs: fx.aliceGrant.writableGraphs ?? [] });
        expect(drop.status).toBe(403);

        // Bobs Graph ist unverändert.
        const bobs = await executeSparqlProtocol(fx.store, bob, {
            method: 'POST', contentType: 'application/sparql-query', body: 'SELECT ?o WHERE { ?s ?p ?o }',
        }, { allowedGraphs: fx.bobGrant.readableGraphs });
        expect(bobs.body).toContain(SECRET_TITLE);

        // Ein NEUER Graph außerhalb des Rechts entsteht auch nicht.
        const invent = await executeSparqlProtocol(fx.store, alice, {
            method: 'POST',
            contentType: 'application/sparql-update',
            body: `INSERT DATA { GRAPH <${bob.graph('public')}> { <urn:x> <urn:y> "z" } }`,
        }, { allowedGraphs: fx.aliceGrant.readableGraphs, writableGraphs: fx.aliceGrant.writableGraphs ?? [] });
        expect(invent.status).toBe(403);
        expect((await fx.store.graphs()).map(g => g.value)).not.toContain(bob.graph('public'));

        // Der eigene Workspace bleibt beschreibbar — die Klammer verengt,
        // sie legt nicht still.
        const own = await executeSparqlProtocol(fx.store, alice, {
            method: 'POST',
            contentType: 'application/sparql-update',
            body: `INSERT DATA { GRAPH <${alice.graph('workspace')}> { <urn:x> <urn:y> "z" } }`,
        }, { allowedGraphs: fx.aliceGrant.readableGraphs, writableGraphs: fx.aliceGrant.writableGraphs ?? [] });
        expect(own.status).toBe(204);
    });

    it('Fehlermeldung: gesperrter und nicht existenter Knoten sind ununterscheidbar', async () => {
        const blocked = await query(`DESCRIBE <${SECRET_DOC}>`, fx.aliceGrant, 'text/turtle');
        const missing = await query(`DESCRIBE <${MISSING_DOC}>`, fx.aliceGrant, 'text/turtle');
        expect(blocked.status).toBe(missing.status);
        expect(blocked.body).toBe(missing.body);

        const blockedAsk = await query(`ASK { <${SECRET_DOC}> ?p ?o }`);
        const missingAsk = await query(`ASK { <${MISSING_DOC}> ?p ?o }`);
        expect(blockedAsk.body).toBe(missingAsk.body);
    });
});

describe('M13 §17.6 — Retrieval, Suche und Inferenz', () => {
    it('Multi-Hop-Retrieval: der Seed neben G führt nicht hinein', async () => {
        const dataset = await retrievalDataset(fx.aliceHandle, {
            includeInferred: false,
            allowedGraphs: fx.aliceGrant.readableGraphs,
        });
        expect(dataset).not.toContain(bob.graph('workspace'));

        const result = await retrieve(
            fx.aliceHandle,
            { seeds: { iri: [ALICE_DOC] }, maxHops: 4, format: 'both' },
            { fulltext: await buildFulltextIndexForGraphs(fx.aliceHandle, dataset) },
            { allowedGraphs: fx.aliceGrant.readableGraphs },
        );
        expectNoLeak(result);
        // Der Knoten wird nicht einmal als nackte IRI aufgenommen: eine
        // Kante ins Gesperrte endet im Nichts (§7.6/§17.4).
        expect(result.nodes.map(node => node.iri)).not.toContain(SECRET_DOC);

        // Gegenprobe: mit Bobs Grant ist derselbe Pfad begehbar.
        const bobDataset = await retrievalDataset(fx.bobHandle, {
            includeInferred: false,
            allowedGraphs: fx.bobGrant.readableGraphs,
        });
        const bobResult = await retrieve(
            fx.bobHandle,
            { seeds: { iri: [SECRET_DOC] }, maxHops: 1, format: 'both' },
            { fulltext: await buildFulltextIndexForGraphs(fx.bobHandle, bobDataset) },
            { allowedGraphs: fx.bobGrant.readableGraphs },
        );
        expect(bobResult.nodes.map(node => node.iri)).toContain(SECRET_DOC);
    });

    it('Volltextsuche: der Index kennt fremde Literale gar nicht', async () => {
        const dataset = await retrievalDataset(fx.aliceHandle, {
            includeInferred: false,
            allowedGraphs: fx.aliceGrant.readableGraphs,
        });
        const index = await buildFulltextIndexForGraphs(fx.aliceHandle, dataset);
        // §17.4: partitioniert, nicht nachgefiltert — auch die Trefferzahl
        // und die Scores verraten nichts, weil nichts drin ist.
        expect(index.search('Nordlicht', { limit: 10 })).toEqual([]);
        expect(index.search('Übernahmeplanung', { limit: 10 })).toEqual([]);
        expect(index.search('Alices', { limit: 10 }).length).toBeGreaterThan(0);
    });

    it('Vektorsuche: der Vektorindex ist genauso partitioniert', async () => {
        // Deterministischer Provider: Ähnlichkeit über gemeinsame Wörter.
        const provider: EmbeddingProvider = {
            id: 'test', model: 'test-1',
            embed: async texts => texts.map(text => {
                const vector = new Array(26).fill(0);
                for (const char of text.toLowerCase()) {
                    const index = char.charCodeAt(0) - 97;
                    if (index >= 0 && index < 26) vector[index] += 1;
                }
                return vector;
            }),
        };
        const dataset = await retrievalDataset(fx.aliceHandle, {
            includeInferred: false,
            allowedGraphs: fx.aliceGrant.readableGraphs,
        });
        const nodes: Array<{ iri: string; graph: string; text: string }> = [];
        for (const graph of dataset) {
            for await (const quad of fx.store.dump(nn(graph))) {
                if (quad.object.termType !== 'Literal') continue;
                nodes.push({
                    iri: quad.subject.value,
                    graph,
                    text: embeddingTextForNode({ label: quad.object.value, texts: [] }),
                });
            }
        }
        const index = await buildVectorIndex(nodes, provider);
        const [queryVector] = await provider.embed([SECRET_TEXT]);
        const hits = index.search(queryVector, { limit: 10, graphs: dataset });
        expect(hits.map(hit => hit.iri)).not.toContain(SECRET_DOC);
        expect(hits.every(hit => dataset.includes(hit.graph))).toBe(true);
    });

    it('Inferenz-Graph: Alices Hülle enthält keinen Schluss aus Bobs Aussagen', async () => {
        await runReasoning(fx.aliceHandle);
        const inferred: Quad[] = [];
        for await (const quad of fx.store.dump(nn(alice.inferredGraph('workspace')))) inferred.push(quad);
        expectNoLeak(inferred.map(q => `${q.subject.value} ${q.predicate.value} ${q.object.value}`).join('\n'));
        expect(inferred.some(q => q.subject.value === SECRET_DOC)).toBe(false);

        const publicInferred: Quad[] = [];
        for await (const quad of fx.store.dump(nn(alice.inferredGraph('public')))) publicInferred.push(quad);
        expect(publicInferred.some(q => q.subject.value === SECRET_DOC)).toBe(false);
    });
});

describe('M13 §17.6 — MCP-Server', () => {
    interface McpFixture {
        host: McpHost;
        client: (token: string) => Promise<Client>;
    }

    async function mcpFixture(): Promise<McpFixture> {
        const host = new McpHost({
            graph: async () => fx.aliceHandle,
            tokens: () => parseMcpTokens(TOKEN_CONFIG),
            capable: true,
            retrievalDeps: async (handle, dataset) => ({ fulltext: await buildFulltextIndexForGraphs(handle, dataset) }),
            sessionId: (() => {
                let n = 0;
                return () => `session-${n += 1}`;
            })(),
        });
        return {
            host,
            client: async (token: string) => {
                const client = new Client({ name: 'matrix-test', version: '1.0.0' });
                await client.connect(new StreamableHTTPClientTransport(new URL('https://ws.test/api/mcp'), {
                    requestInit: { headers: { authorization: `Bearer ${token}` } },
                    fetch: (input, init) => host.handle(new Request(String(input), init as RequestInit)),
                }));
                return client;
            },
        };
    }

    it('graph_retrieve: der Kontext eines fremden Tokens bleibt fremd', async () => {
        const mcp = await mcpFixture();
        const client = await mcp.client(ALICE_TOKEN);
        const result = await client.callTool({
            name: 'graph_retrieve',
            arguments: { seeds: { iri: [ALICE_DOC] }, maxHops: 4 },
        });
        expectNoLeak(result);
        await client.close();
    });

    it('graph_describe: der fremde Knoten hat keine Beschreibung', async () => {
        const mcp = await mcpFixture();
        const client = await mcp.client(ALICE_TOKEN);
        const blocked = await client.callTool({ name: 'graph_describe', arguments: { iri: SECRET_DOC } });
        const missing = await client.callTool({ name: 'graph_describe', arguments: { iri: MISSING_DOC } });
        expectNoLeak(blocked);
        // Gesperrt und nicht existent antworten gleich (§17.3).
        expect(JSON.stringify(blocked)).toBe(JSON.stringify(missing).replaceAll(MISSING_DOC, SECRET_DOC));

        const bobClient = await mcp.client(BOB_TOKEN);
        expect(JSON.stringify(await bobClient.callTool({ name: 'graph_describe', arguments: { iri: SECRET_DOC } })))
            .toContain(SECRET_TITLE);
        await client.close();
        await bobClient.close();
    });

    it('Resource graph://<iri>: liefert außerhalb des Datasets nichts', async () => {
        const mcp = await mcpFixture();
        const client = await mcp.client(ALICE_TOKEN);
        const resource = await client.readResource({ uri: graphResourceUri(SECRET_DOC) });
        expectNoLeak(resource);
        await client.close();
    });

    it('graph_search und graph_sparql laufen durch dieselbe Klammer', async () => {
        const mcp = await mcpFixture();
        const client = await mcp.client(ALICE_TOKEN);
        // Die Suche gibt den Suchbegriff zurück (Eingabe des Aufrufers,
        // kein Fund) — geprüft wird die Trefferliste.
        const search = await client.callTool({ name: 'graph_search', arguments: { query: 'Nordlicht' } });
        expect(JSON.stringify(search)).toContain('\\"hits\\": []');
        expect(JSON.stringify(search)).not.toContain(SECRET_TITLE);
        expectNoLeak(await client.callTool({
            name: 'graph_sparql',
            arguments: { query: `SELECT ?o WHERE { GRAPH <${bob.graph('workspace')}> { ?s ?p ?o } }` },
        }));
        await client.close();
    });
});

describe('M13 §17.6 — Föderation', () => {
    it('eingehend: ein fremdes Token sieht nur sein eigenes Dataset', async () => {
        const host = new FederationEndpointHost({
            graph: async () => fx.aliceHandle,
            tokens: () => parseMcpTokens(TOKEN_CONFIG),
            capable: true,
        });
        const ask = (token?: string) => new Request('https://ws.test/api/graph/federation/sparql', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/sparql-query',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: `SELECT ?o FROM <${bob.graph('workspace')}> WHERE { ?s <${SCHEMA.name}> ?o }`,
        });

        const withAlice = await host.handle(ask(ALICE_TOKEN), 'POST');
        expect(withAlice.status).toBe(200);
        expectNoLeak(await withAlice.text());

        const anonymous = await host.handle(ask(), 'POST');
        expect(anonymous.status).toBe(200);
        expectNoLeak(await anonymous.text());

        const withBob = await host.handle(ask(BOB_TOKEN), 'POST');
        expect(await withBob.text()).toContain(SECRET_TITLE);
    });

    it('ausgehend: kein Binding aus G verlässt den Rechner', async () => {
        await createFederatedEndpoint(fx.aliceHandle, {
            id: 'partner',
            name: 'Partner',
            url: 'https://sparql.example.org/query',
            trustLevel: 'trusted',
        });
        const sent: string[] = [];
        const dataset = await resolveDataset(fx.store, alice, undefined, { allowedGraphs: fx.aliceGrant.readableGraphs });
        const plan = await planFederatedQuery(
            `SELECT ?name ?extern WHERE {
                ?doc <${SCHEMA.name}> ?name .
                SERVICE <https://sparql.example.org/query> { ?name <${SCHEMA.about}> ?extern . }
            }`,
            dataset,
            {
                endpoints: [{
                    id: 'partner',
                    iri: alice.entity('endpoint', 'partner'),
                    name: 'Partner',
                    url: 'https://sparql.example.org/query',
                    trustLevel: 'trusted',
                }],
                store: fx.store,
                fetchImpl: async (input, init) => {
                    sent.push(String((init as RequestInit | undefined)?.body ?? ''));
                    return new Response(
                        JSON.stringify({ head: { vars: ['name', 'extern'] }, results: { bindings: [] } }),
                        { headers: { 'Content-Type': 'application/sparql-results+json' } },
                    );
                },
            },
        );
        expect(plan.report.calls.length).toBeGreaterThan(0);
        // Der ausgehende Query-Text ist der Beweis: Bobs Literal steht
        // nirgends darin, obwohl der Bound-Join lokale Werte mitschickt.
        for (const body of sent) expectNoLeak(decodeURIComponent(body));
        expect(sent.join('\n')).toContain('Alices Notiz');
    });
});

describe('M13 §17.6 — Export, Git-Sync und Canvas', () => {
    it('Export: der Umfang eines Nutzers berührt fremde Verzeichnisse nicht', () => {
        const dataDir = path.join('/tmp', 'ow-data');
        const aliceScope = exportScopeFor('alice', false, dataDir);
        const bobScope = exportScopeFor('bob', false, dataDir);
        expect(aliceScope.directories.some(dir => bobScope.directories.includes(dir))).toBe(false);
        for (const dir of aliceScope.directories) expect(dir).toContain(`${path.sep}alice`);
        // Instanzweite Bestände (Chats, Einstellungen) gehören keinem
        // einzelnen Nutzer — ohne Verwaltung sind sie nicht dabei.
        expect(aliceScope.directories.some(dir => dir.endsWith(`${path.sep}chat`))).toBe(false);
        expect(exportScopeFor('alice', true, dataDir).directories.some(dir => dir.endsWith(`${path.sep}chat`))).toBe(true);
    });

    it('Git-Sync: ein Backup ohne Verwaltung aller Graphen wird abgelehnt', async () => {
        const existing = (await fx.store.graphs()).map(g => g.value);
        const refusal = snapshotExportRefusal(fx.aliceGrant, INSTANCE_BASE, existing);
        expect(refusal).toMatch(/§17.4/);

        // Ein Verwalter mit control auf allem darf es.
        const allControl: AccessGrant = { ...fx.aliceGrant, controlGraphs: existing };
        expect(snapshotExportRefusal(allControl, INSTANCE_BASE, existing)).toBeNull();
    });

    it('Canvas-Referenz: eine Karte auf einen fremden Knoten zeigt ins Leere', async () => {
        // Der Präsentations-Graph ist kein Wissens-Graph und liegt ohnehin
        // außerhalb des Default-Datasets; entscheidend ist, dass die
        // Referenz nichts über das Ziel verrät.
        const response = await executeSparqlProtocol(fx.store, alice, {
            method: 'POST',
            contentType: 'application/sparql-query',
            body: `SELECT ?karte ?ziel ?name WHERE {
                GRAPH <${alice.graph('presentation')}> { ?karte <${OW.rendersNode}> ?ziel }
                OPTIONAL { ?ziel <${SCHEMA.name}> ?name }
            }`,
            accept: 'application/sparql-results+json',
        }, {
            allowedGraphs: fx.aliceGrant.readableGraphs,
            namedGraphUris: [alice.graph('presentation')],
            defaultGraphUris: [alice.graph('presentation'), alice.graph('workspace')],
        } as never);
        expectNoLeak(response.body);
    });
});

describe('M13 §17.6 — anonymer Zugriff', () => {
    it('sieht ohne Freigabe nichts und über keinen Pfad etwas', async () => {
        const anonymous = await grantForIdentity(fx.aliceHandle, ANONYMOUS_IDENTITY);
        expect(anonymous.readableGraphs).not.toContain(alice.graph('workspace'));
        expect(anonymous.readableGraphs).not.toContain(bob.graph('workspace'));
        expect(anonymous.writableGraph).toBeNull();

        const response = await executeSparqlProtocol(fx.store, alice, {
            method: 'POST', contentType: 'application/sparql-query', body: 'SELECT ?s ?p ?o WHERE { ?s ?p ?o }',
        }, { allowedGraphs: anonymous.readableGraphs });
        expectNoLeak(response.body);
        expect(response.body).not.toContain('Alices Notiz');
    });
});
