// @vitest-environment node
/**
 * M11-Abnahme Föderation (GRAPH_CORE_SPEC §7.4, §13):
 *
 *  1. **Live-Query gegen Wikidata liefert Ergebnisse.** Der Test läuft
 *     als echter Netz-Test, wenn `OW_FEDERATION_LIVE=1` gesetzt ist
 *     (Sandboxes ohne Egress überspringen ihn ehrlich statt grün zu
 *     lügen). Derselbe Pfad — Registry → Planer → SPARQL-Protokoll über
 *     den SSRF-Guard — wird ohne Netz deterministisch gegen einen Stub
 *     geprüft, der echtes SPARQL-Results-JSON spricht.
 *  2. **Negativtest eingehende Föderation**: Ein unauthentifizierter
 *     Zugriff sieht ausschließlich explizit freigegebene Named Graphs.
 *     Die Query setzt ein manipuliertes `FROM` ab — das Dataset wird
 *     injiziert, nicht nachgefiltert, und bleibt leer.
 *  3. Endpoint-Registry als `ow:FederatedEndpoint` + `ow:trustLevel` in
 *     `graph/meta` (per SPARQL abfragbar), SSRF-Politik schon beim
 *     Registrieren.
 *  4. Vertrauensstufen mit Wirkung: `unknown` gesperrt, `known` ohne
 *     lokale Bindungen (Leak-Negativtest über den ausgehenden Query-Text),
 *     `trusted` mit Bound-Join.
 *  5. Timeouts und Ergebnis-Limits sind Pflicht — Überschreitung ist ein
 *     Fehler, keine stille Kürzung.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Quad } from '@rdfjs/types';
import { OxigraphStore } from '@/lib/graph/store/oxigraph';
import { createIriFactory } from '@/lib/graph/iri';
import { factory, literal, namedNode } from '@/lib/graph/rdf';
import { OW, RDF, SCHEMA } from '@/lib/graph/vocab';
import { executeSparqlProtocol, resolveDataset } from '@/lib/graph/sparql/protocol';
import {
    createFederatedEndpoint,
    deleteFederatedEndpoint,
    getFederatedEndpoint,
    listFederatedEndpoints,
    updateFederatedEndpoint,
    type GraphHandle,
} from '@/lib/graph/federation/registry';
import { findServiceClauses, maskSparql, variablesIn } from '@/lib/graph/federation/parse';
import { hasServiceClause, planFederatedQuery, summarizeFederation } from '@/lib/graph/federation/service';
import { probeEndpoint, remoteSelect, FederationError } from '@/lib/graph/federation/remote';
import { FederationEndpointHost } from '@/lib/graph/federation/inbound';
import { parseMcpTokens } from '@/lib/graph/mcp/tokens';

const INSTANCE_BASE = 'urn:ow:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee:';
const iri = createIriFactory(INSTANCE_BASE);
const nn = namedNode;

const WORKSPACE = nn(iri.graph('workspace'));
/** Der gesperrte Graph des Negativtests. */
const SECRET_GRAPH = nn(iri.importGraph('geheim'));

const doc = (id: string) => iri.entity('doc', id);

const WIKIDATA_URL = 'https://query.wikidata.org/sparql';
const STUB_URL = 'https://sparql.example.org/query';

/** Wikidata-IRIs, auf die der lokale Graph verweist. */
const Q_GRAPH_DB = 'http://www.wikidata.org/entity/Q176165';
const Q_RDF = 'http://www.wikidata.org/entity/Q54872';

function buildQuads(): Quad[] {
    const quads: Quad[] = [];
    const add = (s: string, p: string, o: Parameters<typeof factory.quad>[2], g = WORKSPACE) =>
        quads.push(factory.quad(nn(s), nn(p), o, g));

    add(doc('graphen'), RDF.type, nn(OW.Document));
    add(doc('graphen'), SCHEMA.name, literal('Notiz über Graphdatenbanken'));
    add(doc('graphen'), SCHEMA.about, nn(Q_GRAPH_DB));

    add(doc('rdf'), RDF.type, nn(OW.Document));
    add(doc('rdf'), SCHEMA.name, literal('Notiz über RDF'));
    add(doc('rdf'), SCHEMA.about, nn(Q_RDF));

    add(doc('geheim'), RDF.type, nn(OW.Document), SECRET_GRAPH);
    add(doc('geheim'), SCHEMA.name, literal('Vertrauliche Notiz'), SECRET_GRAPH);
    return quads;
}

async function freshStore(): Promise<GraphHandle> {
    const store = new OxigraphStore();
    const quads = buildQuads();
    await store.load(quads.filter(q => q.graph.value === WORKSPACE.value), WORKSPACE);
    await store.load(quads.filter(q => q.graph.value === SECRET_GRAPH.value), SECRET_GRAPH);
    return { store, iri };
}

/** Stub-Endpoint, der echtes SPARQL-Results-JSON spricht. */
interface StubCall {
    url: string;
    query: string;
}

function jsonResults(vars: string[], rows: Array<Record<string, { type: string; value: string; datatype?: string; 'xml:lang'?: string }>>): string {
    return JSON.stringify({ head: { vars }, results: { bindings: rows } });
}

function stubFetch(
    respond: (query: string) => { body: string; status?: number; delayMs?: number },
): { fetchImpl: typeof fetch; calls: StubCall[] } {
    const calls: StubCall[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input.toString();
        const query = typeof init?.body === 'string' ? init.body : '';
        calls.push({ url, query });
        const answer = respond(query);
        if (answer.delayMs) {
            // Ein ehrlicher fetch-Stub achtet auf das Abbruch-Signal —
            // sonst prüfte der Zeitbudget-Test nichts.
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, answer.delayMs);
                init?.signal?.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(new DOMException('The operation was aborted.', 'AbortError'));
                }, { once: true });
            });
        }
        return new Response(answer.body, {
            status: answer.status ?? 200,
            headers: { 'Content-Type': 'application/sparql-results+json' },
        });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
}

const originalAllowLocal = process.env.ALLOW_LOCAL_TOOL_URLS;

afterEach(() => {
    if (originalAllowLocal === undefined) delete process.env.ALLOW_LOCAL_TOOL_URLS;
    else process.env.ALLOW_LOCAL_TOOL_URLS = originalAllowLocal;
});

// --- 3. Endpoint-Registry ------------------------------------------------

describe('Endpoint-Registry (SPEC §7.4)', () => {
    it('legt ow:FederatedEndpoint mit ow:trustLevel in graph/meta ab — per SPARQL auffindbar', async () => {
        const handle = await freshStore();
        const created = await createFederatedEndpoint(handle, {
            id: 'wikidata',
            name: 'Wikidata',
            url: WIKIDATA_URL,
            description: 'Öffentlicher SPARQL-Endpoint der Wikimedia Foundation',
            now: new Date('2026-08-09T10:00:00.000Z'),
        });
        // Default ist die strengste Stufe: registriert heißt nicht benutzbar.
        expect(created.trustLevel).toBe('unknown');

        const response = await executeSparqlProtocol(handle.store, handle.iri, {
            method: 'GET',
            accept: 'application/sparql-results+json',
            query: `PREFIX ow: <${OW.FederatedEndpoint.split('#')[0]}#>
                SELECT ?name ?url ?trust WHERE {
                    ?ep a ow:FederatedEndpoint ;
                        <${SCHEMA.name}> ?name ;
                        ow:sparqlEndpoint ?url ;
                        ow:trustLevel ?trust .
                }`,
        });
        expect(response.status).toBe(200);
        const rows = JSON.parse(response.body).results.bindings;
        expect(rows).toHaveLength(1);
        expect(rows[0].name.value).toBe('Wikidata');
        expect(rows[0].url.value).toBe(WIKIDATA_URL);
        expect(rows[0].trust.value).toBe('unknown');

        const raised = await updateFederatedEndpoint(handle, 'wikidata', { trustLevel: 'known' });
        expect(raised?.trustLevel).toBe('known');
        expect((await listFederatedEndpoints(handle))).toHaveLength(1);

        expect(await deleteFederatedEndpoint(handle, 'wikidata')).toBe(true);
        expect(await getFederatedEndpoint(handle, 'wikidata')).toBeNull();
        expect(await listFederatedEndpoints(handle)).toHaveLength(0);
    });

    it('lehnt private/lokale Endpoints schon beim Registrieren ab (SSRF-Politik)', async () => {
        const handle = await freshStore();
        delete process.env.ALLOW_LOCAL_TOOL_URLS;
        await expect(createFederatedEndpoint(handle, {
            id: 'metadaten',
            name: 'Cloud-Metadaten',
            url: 'http://169.254.169.254/latest/meta-data/',
        })).rejects.toThrow(/blockiert/);
        await expect(createFederatedEndpoint(handle, {
            id: 'datei',
            name: 'Datei',
            url: 'file:///etc/passwd',
        })).rejects.toThrow(/http\(s\)/);
        expect(await listFederatedEndpoints(handle)).toHaveLength(0);
    });

    it('blockiert ausgehende Aufrufe auf private Adressen auch zur Laufzeit', async () => {
        delete process.env.ALLOW_LOCAL_TOOL_URLS;
        const { fetchImpl, calls } = stubFetch(() => ({ body: jsonResults([], []) }));
        await expect(remoteSelect('http://10.0.0.5/sparql', 'ASK { ?s ?p ?o }', { fetchImpl }))
            .rejects.toBeInstanceOf(FederationError);
        // Der Guard greift VOR dem Netzaufruf.
        expect(calls).toHaveLength(0);
    });
});

// --- SERVICE-Erkennung ---------------------------------------------------

describe('SERVICE-Erkennung', () => {
    it('ignoriert SERVICE in Kommentaren, Strings und IRIs', () => {
        const query = `# SERVICE <http://kommentar> { ?s ?p ?o }
            SELECT * WHERE {
                ?s <${SCHEMA.name}> "ein SERVICE { im String }" .
                ?s <http://example.org/SERVICE> ?o .
            }`;
        expect(findServiceClauses(query)).toHaveLength(0);
        expect(hasServiceClause(query)).toBe(false);
        // Die Maske ist positionstreu.
        expect(maskSparql(query)).toHaveLength(query.length);
    });

    it('findet Endpoint, SILENT, Muster und Verschachtelungstiefe', () => {
        const query = `SELECT * WHERE {
            ?s <${SCHEMA.about}> ?thema .
            SERVICE SILENT <${WIKIDATA_URL}> { ?thema <http://www.w3.org/2000/01/rdf-schema#label> ?label . }
            OPTIONAL { SERVICE <${STUB_URL}> { ?thema ?p ?o } }
        }`;
        const clauses = findServiceClauses(query);
        expect(clauses).toHaveLength(2);
        expect(clauses[0].silent).toBe(true);
        expect(clauses[0].endpointIri).toBe(WIKIDATA_URL);
        expect(clauses[0].depth).toBe(1);
        expect(variablesIn(clauses[0].pattern)).toEqual(['label', 'thema']);
        // Innerhalb von OPTIONAL: kein reiner Join, also kein Bound-Join.
        expect(clauses[1].depth).toBe(2);
    });
});

// --- 4. Vertrauensstufen mit Wirkung ------------------------------------

describe('Ausgehende Föderation (SPEC §7.4)', () => {
    const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

    async function withEndpoint(trustLevel: 'unknown' | 'known' | 'trusted') {
        const handle = await freshStore();
        await createFederatedEndpoint(handle, { id: 'stub', name: 'Stub', url: STUB_URL, trustLevel });
        return handle;
    }

    const federatedQuery = `SELECT ?doc ?label WHERE {
        ?doc <${SCHEMA.about}> ?thema .
        SERVICE <${STUB_URL}> { ?thema <${LABEL}> ?label . }
    }`;

    const stubAnswer = () => ({
        body: jsonResults(['thema', 'label'], [
            { thema: { type: 'uri', value: Q_GRAPH_DB }, label: { type: 'literal', value: 'Graphdatenbank', 'xml:lang': 'de' } },
            { thema: { type: 'uri', value: Q_RDF }, label: { type: 'literal', value: 'RDF', 'xml:lang': 'de' } },
            { thema: { type: 'uri', value: 'http://www.wikidata.org/entity/Q42' }, label: { type: 'literal', value: 'Fremd', 'xml:lang': 'de' } },
        ]),
    });

    it('known: wertet eigenständig aus und schickt KEINE lokale Bindung raus', async () => {
        const handle = await withEndpoint('known');
        const { fetchImpl, calls } = stubFetch(stubAnswer);
        const dataset = await resolveDataset(handle.store, handle.iri);
        const plan = await planFederatedQuery(federatedQuery, dataset, {
            endpoints: await listFederatedEndpoints(handle),
            store: handle.store,
            fetchImpl,
        });

        expect(plan.report.calls[0].mode).toBe('standalone');
        expect(plan.report.calls[0].pushedBindings).toBe(0);
        expect(calls).toHaveLength(1);
        // Leak-Negativtest: kein lokaler Wert im ausgehenden Query-Text.
        expect(calls[0].query).not.toContain('VALUES');
        expect(calls[0].query).not.toContain(INSTANCE_BASE);
        expect(calls[0].query).not.toContain(Q_GRAPH_DB);

        // Der Join passiert lokal — das fremde Q42 fällt dabei heraus.
        const result = await handle.store.query(plan.query, {
            defaultGraphs: dataset.defaultGraphs,
            namedGraphs: dataset.namedGraphs,
        });
        expect(result.type).toBe('bindings');
        const rows: Array<Record<string, { value: string }>> = [];
        if (result.type === 'bindings') for await (const row of result.bindings) rows.push(row);
        expect(rows).toHaveLength(2);
        expect(rows.map(r => r.label.value).sort()).toEqual(['Graphdatenbank', 'RDF']);
    });

    it('trusted: schickt die lokalen Join-Schlüssel als VALUES mit (Bound-Join)', async () => {
        const handle = await withEndpoint('trusted');
        const { fetchImpl, calls } = stubFetch(stubAnswer);
        const dataset = await resolveDataset(handle.store, handle.iri);
        const plan = await planFederatedQuery(federatedQuery, dataset, {
            endpoints: await listFederatedEndpoints(handle),
            store: handle.store,
            fetchImpl,
        });

        expect(plan.report.calls[0].mode).toBe('bound-join');
        expect(plan.report.calls[0].pushedBindings).toBe(2);
        expect(calls[0].query).toContain('VALUES');
        expect(calls[0].query).toContain(Q_GRAPH_DB);
        expect(calls[0].query).toContain(Q_RDF);
        // Auch beim Bound-Join verlassen nur die Join-Schlüssel den
        // Rechner — keine lokalen IRIs, keine Titel.
        expect(calls[0].query).not.toContain(INSTANCE_BASE);
        expect(calls[0].query).not.toContain('Notiz über');
        expect(summarizeFederation(plan.report)).toContain('bound-join');
    });

    it('unknown: SERVICE ist gesperrt — mit SILENT wird daraus die leere Lösung', async () => {
        const handle = await withEndpoint('unknown');
        const { fetchImpl, calls } = stubFetch(stubAnswer);
        const dataset = await resolveDataset(handle.store, handle.iri);
        const deps = { endpoints: await listFederatedEndpoints(handle), store: handle.store, fetchImpl };

        await expect(planFederatedQuery(federatedQuery, dataset, deps)).rejects.toThrow(/unknown/);
        expect(calls).toHaveLength(0);

        const silent = federatedQuery.replace('SERVICE <', 'SERVICE SILENT <');
        const plan = await planFederatedQuery(silent, dataset, deps);
        expect(plan.report.calls[0].error).toMatch(/gesperrt/);
        const result = await handle.store.query(plan.query, {
            defaultGraphs: dataset.defaultGraphs,
            namedGraphs: dataset.namedGraphs,
        });
        const rows: unknown[] = [];
        if (result.type === 'bindings') for await (const row of result.bindings) rows.push(row);
        expect(rows).toHaveLength(0);
        expect(calls).toHaveLength(0);
    });

    it('schickt den Prolog mit — das entfernte Muster darf lokale Präfixe benutzen', async () => {
        const handle = await withEndpoint('known');
        const { fetchImpl, calls } = stubFetch(() => ({ body: jsonResults(['thema', 'label'], []) }));
        const dataset = await resolveDataset(handle.store, handle.iri);
        const query = `PREFIX schema: <https://schema.org/>
            PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
            SELECT ?doc ?label WHERE {
                ?doc schema:about ?thema .
                SERVICE <${STUB_URL}> { ?thema rdfs:label ?label . }
            }`;
        await planFederatedQuery(query, dataset, {
            endpoints: await listFederatedEndpoints(handle),
            store: handle.store,
            fetchImpl,
        });
        expect(calls[0].query).toContain('PREFIX rdfs:');
        expect(calls[0].query).toContain('rdfs:label');
    });

    it('lehnt nicht registrierte Endpoints ab', async () => {
        const handle = await withEndpoint('known');
        const { fetchImpl, calls } = stubFetch(stubAnswer);
        const dataset = await resolveDataset(handle.store, handle.iri);
        await expect(planFederatedQuery(
            federatedQuery.replace(STUB_URL, 'https://fremder-endpoint.example/sparql'),
            dataset,
            { endpoints: await listFederatedEndpoints(handle), store: handle.store, fetchImpl },
        )).rejects.toThrow(/nicht registriert/);
        expect(calls).toHaveLength(0);
    });

    it('Ergebnis-Limit ist Pflicht: Überschreitung ist ein Fehler, keine stille Kürzung', async () => {
        const handle = await withEndpoint('known');
        const many = Array.from({ length: 50 }, (_, index) => ({
            thema: { type: 'uri', value: `http://www.wikidata.org/entity/Q${index}` },
            label: { type: 'literal', value: `Label ${index}` },
        }));
        const { fetchImpl } = stubFetch(() => ({ body: jsonResults(['thema', 'label'], many) }));
        const dataset = await resolveDataset(handle.store, handle.iri);
        await expect(planFederatedQuery(federatedQuery, dataset, {
            endpoints: await listFederatedEndpoints(handle),
            store: handle.store,
            fetchImpl,
            maxRows: 10,
        })).rejects.toThrow(/Ergebnis-Limit/);
    });

    it('Zeitbudget ist Pflicht: ein hängender Endpoint bricht ab', async () => {
        const { fetchImpl } = stubFetch(() => ({ body: jsonResults([], []), delayMs: 200 }));
        await expect(remoteSelect(STUB_URL, 'ASK { ?s ?p ?o }', { fetchImpl, timeoutMs: 20 }))
            .rejects.toThrow(/Zeitlimit/);
        const probe = await probeEndpoint(STUB_URL, { fetchImpl, timeoutMs: 20 });
        expect(probe.reachable).toBe(false);
        expect(probe.message).toMatch(/Zeitlimit/);
    });

    it('meldet einen erreichbaren Endpoint ehrlich als erreichbar', async () => {
        const { fetchImpl } = stubFetch(() => ({ body: JSON.stringify({ head: {}, boolean: true }) }));
        const probe = await probeEndpoint(STUB_URL, { fetchImpl });
        expect(probe.reachable).toBe(true);
        expect(probe.checkedAt).toMatch(/^\d{4}-/);
    });

    it('läuft als Ganzes durch das SPARQL-Protokoll (Endpoint-Pfad)', async () => {
        const handle = await withEndpoint('known');
        const { fetchImpl } = stubFetch(stubAnswer);
        const endpoints = await listFederatedEndpoints(handle);
        const response = await executeSparqlProtocol(handle.store, handle.iri, {
            method: 'POST',
            contentType: 'application/sparql-query',
            accept: 'application/sparql-results+json',
            body: federatedQuery,
        }, {
            federation: async (query, dataset) =>
                (await planFederatedQuery(query, dataset, { endpoints, store: handle.store, fetchImpl })).query,
        });
        expect(response.status).toBe(200);
        const rows = JSON.parse(response.body).results.bindings;
        expect(rows).toHaveLength(2);
    });

    it('gibt den Fehler eines gesperrten Endpoints als 403 durch das Protokoll zurück', async () => {
        const handle = await withEndpoint('unknown');
        const { fetchImpl } = stubFetch(stubAnswer);
        const endpoints = await listFederatedEndpoints(handle);
        const response = await executeSparqlProtocol(handle.store, handle.iri, {
            method: 'POST',
            contentType: 'application/sparql-query',
            accept: 'application/sparql-results+json',
            body: federatedQuery,
        }, {
            federation: async (query, dataset) =>
                (await planFederatedQuery(query, dataset, { endpoints, store: handle.store, fetchImpl })).query,
        });
        expect(response.status).toBe(403);
        expect(response.body).toMatch(/unknown/);
    });
});

// --- 1. Abnahme: Live-Query gegen Wikidata -------------------------------

describe('Abnahme: Live-Query gegen Wikidata', () => {
    const live = process.env.OW_FEDERATION_LIVE === '1';
    it.runIf(live)('liefert Ergebnisse über den registrierten Endpoint', async () => {
        const handle = await freshStore();
        await createFederatedEndpoint(handle, {
            id: 'wikidata',
            name: 'Wikidata',
            url: WIKIDATA_URL,
            trustLevel: 'trusted',
        });
        const query = `SELECT ?doc ?label WHERE {
            ?doc <${SCHEMA.about}> ?thema .
            SERVICE <${WIKIDATA_URL}> {
                ?thema <http://www.w3.org/2000/01/rdf-schema#label> ?label .
                FILTER(LANG(?label) = "de")
            }
        }`;
        const dataset = await resolveDataset(handle.store, handle.iri);
        const plan = await planFederatedQuery(query, dataset, {
            endpoints: await listFederatedEndpoints(handle),
            store: handle.store,
            timeoutMs: 30_000,
        });
        expect(plan.report.calls[0].error).toBeUndefined();
        expect(plan.report.calls[0].rows).toBeGreaterThan(0);

        const result = await handle.store.query(plan.query, {
            defaultGraphs: dataset.defaultGraphs,
            namedGraphs: dataset.namedGraphs,
        });
        const rows: Array<Record<string, { value: string }>> = [];
        if (result.type === 'bindings') for await (const row of result.bindings) rows.push(row);
        expect(rows.length).toBeGreaterThan(0);
    }, 60_000);

    it.skipIf(live)('übersprungen ohne OW_FEDERATION_LIVE=1 (kein Netz in der Sandbox)', () => {
        // Dokumentiert die Bedingung, statt das Ergebnis vorzutäuschen:
        // `OW_FEDERATION_LIVE=1 bun run test:run tests/graph/federation.test.ts`
        expect(process.env.OW_FEDERATION_LIVE).not.toBe('1');
    });
});

// --- 2. Abnahme: eingehende Föderation ----------------------------------

describe('Abnahme: eingehende Föderation mit Authz-Rewriting', () => {
    const VOLL_TOKEN = 'token-voll-0123456789abcdef';
    const ENG_TOKEN = 'token-eng-0123456789abcdef';
    const STUMM_TOKEN = 'token-stumm-0123456789abcd';

    const tokens = () => parseMcpTokens(JSON.stringify([
        { id: 'voll', token: VOLL_TOKEN, scopes: ['workspace', 'import/*', 'meta'], sparql: true },
        { id: 'eng', token: ENG_TOKEN, scopes: ['workspace'], sparql: true },
        { id: 'stumm', token: STUMM_TOKEN, scopes: ['workspace'] },
    ]));

    async function hostFor(handle: GraphHandle, overrides: Partial<ConstructorParameters<typeof FederationEndpointHost>[0]> = {}) {
        return new FederationEndpointHost({
            graph: async () => handle,
            tokens,
            capable: true,
            ...overrides,
        });
    }

    function sparqlRequest(query: string, token?: string): Request {
        return new Request('https://workspace.example/api/graph/federation/sparql', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/sparql-query',
                Accept: 'application/sparql-results+json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: query,
        });
    }

    /** Query mit manipuliertem `FROM` auf den gesperrten Graphen. */
    const manipulated = `SELECT ?s ?name
        FROM <${SECRET_GRAPH.value}>
        FROM <${WORKSPACE.value}>
        WHERE { ?s <${SCHEMA.name}> ?name }`;

    it('unauthentifiziert: leeres Dataset — auch mit manipuliertem FROM', async () => {
        const handle = await freshStore();
        const host = await hostFor(handle);
        const response = await host.handle(sparqlRequest(manipulated), 'POST');
        expect(response.status).toBe(200);
        const payload = JSON.parse(await response.text());
        expect(payload.results.bindings).toHaveLength(0);
        expect(response.headers.get('X-OW-Federation-Identity')).toBe('anonym');

        // Auch die Graph-Liste bleibt leer: keine Existenzbestätigung.
        const graphs = await host.handle(sparqlRequest('SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }'), 'POST');
        expect(JSON.parse(await graphs.text()).results.bindings).toHaveLength(0);
    });

    it('unbekanntes Token verhält sich wie unauthentifiziert (kein Orakel)', async () => {
        const handle = await freshStore();
        const host = await hostFor(handle);
        const response = await host.handle(sparqlRequest(manipulated, 'token-erfunden-0123456789'), 'POST');
        expect(response.status).toBe(200);
        expect(JSON.parse(await response.text()).results.bindings).toHaveLength(0);
    });

    it('Token mit engem Scope sieht seinen Graphen — den gesperrten nicht', async () => {
        const handle = await freshStore();
        const host = await hostFor(handle);
        const response = await host.handle(sparqlRequest(manipulated, ENG_TOKEN), 'POST');
        expect(response.status).toBe(200);
        const names = JSON.parse(await response.text()).results.bindings.map((row: { name: { value: string } }) => row.name.value);
        expect(names.sort()).toEqual(['Notiz über Graphdatenbanken', 'Notiz über RDF']);
        expect(names).not.toContain('Vertrauliche Notiz');

        const voll = await host.handle(sparqlRequest(manipulated, VOLL_TOKEN), 'POST');
        const vollNames = JSON.parse(await voll.text()).results.bindings.map((row: { name: { value: string } }) => row.name.value);
        expect(vollNames).toContain('Vertrauliche Notiz');
    });

    it('Token ohne SPARQL-Recht bekommt eine ehrliche Absage', async () => {
        const handle = await freshStore();
        const host = await hostFor(handle);
        const response = await host.handle(sparqlRequest('SELECT * WHERE { ?s ?p ?o }', STUMM_TOKEN), 'POST');
        expect(response.status).toBe(403);
        expect(await response.text()).toMatch(/SPARQL-Recht/);
    });

    it('ist read-only und kein Relais: UPDATE und SERVICE sind gesperrt', async () => {
        const handle = await freshStore();
        const host = await hostFor(handle);
        const update = new Request('https://workspace.example/api/graph/federation/sparql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/sparql-update', Authorization: `Bearer ${VOLL_TOKEN}` },
            body: `INSERT DATA { GRAPH <${WORKSPACE.value}> { <urn:x> <urn:y> <urn:z> } }`,
        });
        expect((await host.handle(update, 'POST')).status).toBe(405);

        const relay = await host.handle(
            sparqlRequest(`SELECT * WHERE { SERVICE <${WIKIDATA_URL}> { ?s ?p ?o } }`, VOLL_TOKEN),
            'POST',
        );
        expect(relay.status).toBe(400);
        expect(await relay.text()).toMatch(/Relais/);

        // Auch eine unlesbare SERVICE-Klausel kommt nicht durch.
        const sneaky = await host.handle(
            sparqlRequest('SELECT * WHERE { SERVICE wd:endpoint { ?s ?p ?o } }', VOLL_TOKEN),
            'POST',
        );
        expect(sneaky.status).toBe(400);
    });

    it('erzwingt Rate-Limit und Ergebnis-Limit', async () => {
        const handle = await freshStore();
        const host = await hostFor(handle, { anonymousRateLimit: 2 });
        const query = 'SELECT * WHERE { ?s ?p ?o }';
        expect((await host.handle(sparqlRequest(query), 'POST')).status).toBe(200);
        expect((await host.handle(sparqlRequest(query), 'POST')).status).toBe(200);
        const limited = await host.handle(sparqlRequest(query), 'POST');
        expect(limited.status).toBe(429);
        expect(limited.headers.get('Retry-After')).toBeTruthy();

        const tight = await hostFor(handle, { maxRows: 1 });
        const capped = await tight.handle(sparqlRequest(`SELECT * WHERE { ?s ?p ?o }`, VOLL_TOKEN), 'POST');
        expect(capped.status).toBe(413);
        expect(await capped.text()).toMatch(/Ergebnis-Limit/);
    });

    it('ist in einer Runtime ohne Fähigkeit ehrlich aus', async () => {
        const handle = await freshStore();
        const host = await hostFor(handle, { capable: false });
        const response = await host.handle(sparqlRequest('SELECT * WHERE { ?s ?p ?o }', VOLL_TOKEN), 'POST');
        expect(response.status).toBe(503);
        expect(await response.text()).toMatch(/nicht verfügbar/);
    });

    it('beantwortet Preflight-Anfragen für browserseitige Föderation', async () => {
        const handle = await freshStore();
        const host = await hostFor(handle);
        const preflight = host.options();
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
});
