// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore } from '../../src/lib/graph/store/oxigraph';
import { executeSparqlProtocol, negotiate, resolveDataset } from '../../src/lib/graph/sparql/protocol';
import { createIriFactory, urnInstanceBase } from '../../src/lib/graph/iri';
import { namedNode, literal, quad } from '../../src/lib/graph/rdf';
import type { SparqlProtocolRequest } from '../../src/lib/graph/sparql/protocol';

const iri = createIriFactory(urnInstanceBase('00000000-0000-4000-8000-000000000000'));
const WS = namedNode(iri.graph('workspace'));
const PRESENTATION = namedNode(iri.graph('presentation'));
const VOCAB = namedNode(iri.sharedGraph('vocab'));
const ACL = namedNode(iri.sharedGraph('acl'));

let store: OxigraphStore;

beforeEach(async () => {
    store = new OxigraphStore();
    await store.load([
        quad(namedNode('urn:ex:a'), namedNode('urn:ex:name'), literal('Alpha', 'de')),
        quad(namedNode('urn:ex:a'), namedNode('urn:ex:knows'), namedNode('urn:ex:b')),
    ], WS);
    await store.load([
        quad(namedNode('urn:ex:layout'), namedNode('urn:ex:hidden'), literal('Layout')),
    ], PRESENTATION);
    await store.load([
        quad(namedNode('urn:ex:vocabTerm'), namedNode('urn:ex:label'), literal('Vokabular')),
    ], VOCAB);
    await store.load([
        quad(namedNode('urn:ex:rule'), namedNode('urn:ex:secret'), literal('geheim')),
    ], ACL);
});

const run = (request: Partial<SparqlProtocolRequest>) =>
    executeSparqlProtocol(store, iri, { method: 'GET', ...request } as SparqlProtocolRequest);

describe('SPARQL 1.1 Protocol (M2-Abnahme)', () => {
    it('SELECT liefert SPARQL-Results-JSON', async () => {
        const res = await run({ query: 'SELECT ?o WHERE { <urn:ex:a> <urn:ex:name> ?o }' });
        expect(res.status).toBe(200);
        expect(res.contentType).toContain('application/sparql-results+json');
        const parsed = JSON.parse(res.body) as {
            head: { vars: string[] };
            results: { bindings: Array<Record<string, { type: string; value: string; 'xml:lang'?: string }>> };
        };
        expect(parsed.head.vars).toEqual(['o']);
        expect(parsed.results.bindings).toHaveLength(1);
        expect(parsed.results.bindings[0].o).toEqual({ type: 'literal', value: 'Alpha', 'xml:lang': 'de' });
    });

    it('SELECT mit Accept text/csv liefert CSV', async () => {
        const res = await run({
            query: 'SELECT ?o WHERE { <urn:ex:a> <urn:ex:name> ?o }',
            accept: 'text/csv',
        });
        expect(res.contentType).toContain('text/csv');
        expect(res.body).toBe('o\r\nAlpha\r\n');
    });

    it('ASK liefert boolean', async () => {
        const res = await run({ query: 'ASK { <urn:ex:a> <urn:ex:name> ?o }' });
        expect(JSON.parse(res.body)).toEqual({ head: {}, boolean: true });
    });

    it('CONSTRUCT verhandelt Turtle und JSON-LD', async () => {
        const query = 'CONSTRUCT { ?s <urn:ex:name> ?o } WHERE { ?s <urn:ex:name> ?o }';
        const turtle = await run({ query, accept: 'text/turtle' });
        expect(turtle.contentType).toContain('text/turtle');
        expect(turtle.body).toContain('urn:ex:a');

        const jsonld = await run({ query, accept: 'application/ld+json' });
        expect(jsonld.contentType).toContain('application/ld+json');
        expect(JSON.stringify(JSON.parse(jsonld.body))).toContain('urn:ex:a');

        const nquads = await run({ query, accept: 'application/n-quads' });
        expect(nquads.body).toContain('<urn:ex:a> <urn:ex:name> "Alpha"@de');
    });

    it('DESCRIBE funktioniert über das Protokoll', async () => {
        const res = await run({ query: 'DESCRIBE <urn:ex:a>' });
        expect(res.status).toBe(200);
        expect(res.body).toContain('urn:ex:a');
    });

    it('UPDATE über GET wird abgelehnt (405)', async () => {
        const res = await run({
            update: `INSERT DATA { GRAPH <${WS.value}> { <urn:ex:x> <urn:ex:p> "x" } }`,
        });
        expect(res.status).toBe(405);
    });

    it('UPDATE über POST schreibt in den Workspace-Graphen', async () => {
        const res = await run({
            method: 'POST',
            contentType: 'application/sparql-update',
            body: `INSERT DATA { GRAPH <${WS.value}> { <urn:ex:neu> <urn:ex:p> "eingefügt" } }`,
        });
        expect(res.status).toBe(204);
        const check = await run({ query: 'ASK { <urn:ex:neu> <urn:ex:p> "eingefügt" }' });
        expect(JSON.parse(check.body).boolean).toBe(true);
    });

    it('UPDATE auf systemverwaltete Graphen wird zurückgerollt (403)', async () => {
        const res = await run({
            method: 'POST',
            contentType: 'application/sparql-update',
            body: `INSERT DATA { GRAPH <${VOCAB.value}> { <urn:ex:evil> <urn:ex:p> "manipuliert" } }`,
        });
        expect(res.status).toBe(403);
        // Nichts angekommen:
        const check = await store.query(`ASK { GRAPH <${VOCAB.value}> { <urn:ex:evil> ?p ?o } }`);
        expect(check.type === 'boolean' && check.value).toBe(false);
    });

    it('DROP eines systemverwalteten Graphen wird zurückgerollt', async () => {
        const res = await run({
            method: 'POST',
            contentType: 'application/sparql-update',
            body: `DROP GRAPH <${VOCAB.value}>`,
        });
        expect(res.status).toBe(403);
        expect((await store.graphs()).map(g => g.value)).toContain(VOCAB.value);
    });

    it('Default-Dataset schließt presentation aus; explizite Anforderung öffnet sie', async () => {
        const hidden = await run({ query: 'SELECT ?o WHERE { <urn:ex:layout> <urn:ex:hidden> ?o }' });
        expect(JSON.parse(hidden.body).results.bindings).toHaveLength(0);

        const explicit = await run({
            query: 'SELECT ?o WHERE { <urn:ex:layout> <urn:ex:hidden> ?o }',
            defaultGraphUris: [PRESENTATION.value],
        });
        expect(JSON.parse(explicit.body).results.bindings).toHaveLength(1);
    });

    it('graph/acl ist über keinen Pfad erreichbar — auch nicht explizit', async () => {
        // Gezielte Anfragen auf ACL-Inhalte liefern leere Ergebnisse …
        for (const request of [
            { query: 'SELECT ?o WHERE { <urn:ex:rule> <urn:ex:secret> ?o }' },
            { query: 'SELECT ?o WHERE { <urn:ex:rule> <urn:ex:secret> ?o }', defaultGraphUris: [ACL.value] },
            { query: 'SELECT ?o WHERE { <urn:ex:rule> <urn:ex:secret> ?o }', namedGraphUris: [ACL.value] },
            { query: 'SELECT ?g ?o WHERE { GRAPH ?g { <urn:ex:rule> ?p ?o } }' },
        ]) {
            const res = await run(request);
            expect(res.status, JSON.stringify(request)).toBe(200);
            expect(JSON.parse(res.body).results.bindings, JSON.stringify(request)).toHaveLength(0);
        }
        // … und breite Anfragen (inkl. manipuliertem FROM, M11-Negativtest-
        // Muster) sehen ausschließlich das erlaubte Dataset, nie das Geheimnis.
        for (const request of [
            { query: `SELECT ?o FROM <${ACL.value}> WHERE { ?s ?p ?o }` },
            { query: 'SELECT ?s ?o WHERE { ?s ?p ?o }' },
            { query: 'SELECT ?g ?s ?o WHERE { GRAPH ?g { ?s ?p ?o } }' },
        ]) {
            const res = await run(request);
            expect(res.status, JSON.stringify(request)).toBe(200);
            const body = res.body;
            expect(body, JSON.stringify(request)).not.toContain('geheim');
            expect(body, JSON.stringify(request)).not.toContain('urn:ex:rule');
            expect(body, JSON.stringify(request)).not.toContain(ACL.value);
        }
    });

    it('nur unerreichbare Graphen angefordert → leeres Dataset, kein Fallback', async () => {
        // Regression: default_graph []/named_graphs [] müssen als leeres
        // Dataset wirken — nie als "ungesetzt" (das wäre ein Leak).
        const res = await run({
            query: 'SELECT ?g ?s ?o WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }',
            defaultGraphUris: [ACL.value],
            namedGraphUris: [ACL.value],
        });
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body).results.bindings).toHaveLength(0);
    });

    it('fehlende query ergibt 400, kaputte Syntax ergibt 400', async () => {
        expect((await run({})).status).toBe(400);
        expect((await run({ query: 'SELECT KAPUTT' })).status).toBe(400);
    });
});

describe('Hilfsfunktionen', () => {
    it('negotiate respektiert q-Werte und Wildcards', () => {
        expect(negotiate('text/csv;q=0.9, application/sparql-results+json;q=0.1',
            ['application/sparql-results+json', 'text/csv'], 'application/sparql-results+json')).toBe('text/csv');
        expect(negotiate('*/*', ['text/turtle'], 'text/turtle')).toBe('text/turtle');
        expect(negotiate('image/png', ['text/turtle'], 'text/turtle')).toBe('');
        expect(negotiate(null, ['text/turtle'], 'text/turtle')).toBe('text/turtle');
    });

    it('resolveDataset filtert nicht lesbare Graphen still', async () => {
        const dataset = await resolveDataset(store, iri, {
            defaultGraphUris: [ACL.value, WS.value, 'urn:fremd:graph'],
        });
        expect(dataset.defaultGraphs.map(g => g.value)).toEqual([WS.value]);
    });
});
