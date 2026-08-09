/**
 * M3-Abnahme (GRAPH_CORE_SPEC §13) als Tests:
 *
 *  1. Import erzeugt `graph/<u>/import/<id>`.
 *  2. PROV-Tripel vollständig (wasDerivedFrom, generatedAtTime,
 *     wasAttributedTo, ow:revision).
 *  3. Erneuter Pull bei unveränderter Revision ist ein No-Op.
 *  4. Bei geänderter Revision ein sauberer Replace.
 *  5. Fehlertoleranz: fehlerhaftes Turtle, unbekannte Prädikate, fehlende
 *     Typen brechen den Import NICHT ab — was parst, wird importiert,
 *     der Rest wird quarantäniert und im Fehlerbericht gemeldet.
 *     (SHACL validiert erst ab M7 — und dann berichtend, nie blockierend.)
 *
 * Dazu Framework-Invarianten: Registry-Knoten in `graph/meta`
 * (Invariante 6), Blank-Node-Disjunktheit über Quell-Dateien,
 * SSRF-Schutz des Connector-Fetch, Locator↔Config-Round-Trip.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import type { Quad } from '@rdfjs/types';
import { OxigraphStore } from '@/lib/graph/store/oxigraph';
import { createIriFactory } from '@/lib/graph/iri';
import { canonicalNQuads } from '@/lib/graph/serialize/canonical';
import { namedNode } from '@/lib/graph/rdf';
import { DCTERMS, OW, PROV, SCHEMA, XSD } from '@/lib/graph/vocab';
import {
    createConnector,
    deleteConnector,
    getConnector,
    listConnectors,
    runErrors,
    MAX_STORED_ERRORS,
    type GraphHandle,
} from '@/lib/graph/connectors/registry';
import { syncConnector } from '@/lib/graph/connectors/sync';
import { createGuardedFetch, ConnectorFetchError } from '@/lib/graph/connectors/http';
import { parseRdfLenient, relabelBlankNodes, rdfFormatForPath } from '@/lib/graph/connectors/quads';
import { githubRdfConnector, parseRepoInput } from '@/lib/graph/connectors/github-rdf';
import { rdfFileConnector } from '@/lib/graph/connectors/rdf-file';
import { getConnectorKind, listConnectorKinds } from '@/lib/graph/connectors/catalog';
import { parseRdf } from '@/lib/graph/serialize/io';

const INSTANCE_BASE = 'urn:ow:12345678-1234-1234-1234-123456789abc:';

type Route = () => Response;

/** Deterministischer fetch-Stub mit Aufruf-Protokoll. */
function makeFetchStub(routes: Map<string, Route>, log: string[]): typeof fetch {
    return (async (input: RequestInfo | URL) => {
        const url = String(input);
        log.push(url);
        const route = routes.get(url);
        if (!route) {
            return new Response('not found', { status: 404 });
        }
        return route();
    }) as typeof fetch;
}

function textResponse(body: string, contentType: string): Route {
    return () => new Response(body, { status: 200, headers: { 'content-type': contentType } });
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

function fixedClock(): () => Date {
    let tick = 0;
    return () => new Date(Date.UTC(2026, 7, 8, 12, 0, tick += 1));
}

describe('Connector-Registry (graph/meta, Invariante 6)', () => {
    let handle: GraphHandle;

    beforeEach(() => {
        handle = { store: new OxigraphStore(), iri: createIriFactory(INSTANCE_BASE) };
    });

    it('legt die Instanz als ow:Connector-Knoten in graph/meta an', async () => {
        const view = await createConnector(handle, {
            id: 'rdf-file-test',
            name: 'Testquelle',
            kind: 'rdf-file',
            locator: 'https://example.org/data.ttl',
        });
        expect(view.targetGraph).toBe(handle.iri.importGraph('rdf-file-test'));

        const meta = await dumpGraph(handle, handle.iri.sharedGraph('meta'));
        const bySubject = meta.filter(q => q.subject.value === view.iri);
        const predicateValues = new Map(bySubject.map(q => [q.predicate.value, q.object.value] as const));
        expect(bySubject.some(q => q.predicate.value.endsWith('#type') && q.object.value === OW.Connector)).toBe(true);
        expect(bySubject.some(q => q.predicate.value.endsWith('#type') && q.object.value === PROV.SoftwareAgent)).toBe(true);
        expect(predicateValues.get(OW.connectorKind)).toBe('rdf-file');
        expect(predicateValues.get(OW.locator)).toBe('https://example.org/data.ttl');
        expect(predicateValues.get(OW.targetGraph)).toBe(view.targetGraph);
        expect(predicateValues.get(OW.syncState)).toBe('idle');
        expect(predicateValues.get(DCTERMS.created)).toBeTruthy();

        // Selbstbeschreibend: die Instanz ist per SPARQL abfragbar.
        const result = await handle.store.query(
            `ASK { GRAPH <${handle.iri.sharedGraph('meta')}> { ?c a <${OW.Connector}> ; <${OW.connectorKind}> "rdf-file" } }`,
        );
        expect(result.type === 'boolean' && result.value).toBe(true);
    });

    it('weist doppelte IDs und ungültige IDs zurück', async () => {
        await createConnector(handle, { id: 'x1', name: 'A', kind: 'rdf-file', locator: 'https://example.org/a.ttl' });
        await expect(
            createConnector(handle, { id: 'x1', name: 'B', kind: 'rdf-file', locator: 'https://example.org/b.ttl' }),
        ).rejects.toThrow(/existiert bereits/);
        await expect(
            createConnector(handle, { id: '../acl', name: 'Böse', kind: 'rdf-file', locator: 'https://example.org/c.ttl' }),
        ).rejects.toThrow(/Ungültige Connector-ID/);
    });

    it('listet Instanzen sortiert und liefert Einzelansichten', async () => {
        await createConnector(handle, { id: 'b', name: 'Beta', kind: 'rdf-file', locator: 'https://example.org/b.ttl' });
        await createConnector(handle, { id: 'a', name: 'Alpha', kind: 'github-rdf', locator: 'https://github.com/o/r' });
        const list = await listConnectors(handle);
        expect(list.map(v => v.name)).toEqual(['Alpha', 'Beta']);
        expect((await getConnector(handle, 'a'))?.kind).toBe('github-rdf');
        expect(await getConnector(handle, 'fehlt')).toBeNull();
    });

    it('kappt den gespeicherten Fehlerbericht deterministisch', () => {
        const entries = Array.from({ length: MAX_STORED_ERRORS + 10 }, (_, i) => ({
            source: `datei-${i}.ttl`,
            reason: 'kaputt',
        }));
        const stored = runErrors(entries);
        expect(stored).toHaveLength(MAX_STORED_ERRORS + 1);
        expect(stored.at(-1)).toContain('10 weitere');
    });
});

describe('rdf-file-Connector: M3-Abnahme', () => {
    let handle: GraphHandle;
    let routes: Map<string, Route>;
    let log: string[];
    let fetchImpl: typeof fetch;
    const url = 'https://example.org/data.ttl';

    beforeEach(async () => {
        handle = { store: new OxigraphStore(), iri: createIriFactory(INSTANCE_BASE) };
        routes = new Map();
        log = [];
        fetchImpl = makeFetchStub(routes, log);
        await createConnector(handle, { id: 'quelle', name: 'Quelle', kind: 'rdf-file', locator: url });
    });

    it('Import erzeugt graph/<u>/import/<id> mit vollständigen PROV-Tripeln — auch für Aussagen ohne Typ und mit unbekannten Prädikaten', async () => {
        // Unbekanntes Prädikat, kein rdf:type — muss trotzdem importieren.
        routes.set(url, textResponse(
            '<https://example.org/e1> <https://example.org/voellig-unbekannt> "Wert" .\n' +
            '<https://example.org/e1> <https://schema.org/name> "Eins" .',
            'text/turtle',
        ));

        const result = await syncConnector(handle, 'quelle', { fetchImpl, now: fixedClock() });
        expect(result.status).toBe('imported');
        expect(result.quarantined).toEqual([]);
        expect(result.revision).toMatch(/^sha256:/);

        const importGraph = handle.iri.importGraph('quelle');
        const graphs = (await handle.store.graphs()).map(g => g.value);
        expect(graphs).toContain(importGraph);

        const quads = await dumpGraph(handle, importGraph);
        expect(quads.some(q => q.predicate.value === 'https://example.org/voellig-unbekannt')).toBe(true);

        // PROV vollständig, Subjekt ist die Import-Graph-IRI selbst.
        const prov = quads.filter(q => q.subject.value === importGraph);
        const derivedFrom = prov.find(q => q.predicate.value === PROV.wasDerivedFrom);
        const generatedAt = prov.find(q => q.predicate.value === PROV.generatedAtTime);
        const attributedTo = prov.find(q => q.predicate.value === PROV.wasAttributedTo);
        const revision = prov.find(q => q.predicate.value === OW.revision);
        expect(derivedFrom?.object.value).toBe(url);
        // Oxigraph normalisiert xsd:dateTime (Millisekunden optional).
        expect(generatedAt?.object.value).toMatch(/^2026-08-08T12:00:02(\.000)?Z$/);
        expect(generatedAt?.object.termType === 'Literal' && generatedAt.object.datatype.value).toBe(XSD.dateTime);
        expect(attributedTo?.object.value).toBe(handle.iri.entity('connector', 'quelle'));
        expect(revision?.object.value).toMatch(/^sha256:/);

        // Meta-Zustand: Revision übernommen, Lauf protokolliert.
        const view = await getConnector(handle, 'quelle');
        expect(view?.revision).toBe(result.revision);
        expect(view?.syncState).toBe('idle');
        expect(view?.lastRun?.summary).toContain('importiert');
    });

    it('unveränderte Revision ist ein No-Op: der Import-Graph bleibt byte-identisch', async () => {
        routes.set(url, textResponse('<https://example.org/e1> <https://schema.org/name> "Eins" .', 'text/turtle'));
        const first = await syncConnector(handle, 'quelle', { fetchImpl, now: fixedClock() });
        expect(first.status).toBe('imported');
        const before = await canonicalNQuads(await dumpGraph(handle, handle.iri.importGraph('quelle')));
        const fetchesAfterFirst = log.length;

        const second = await syncConnector(handle, 'quelle', { fetchImpl, now: fixedClock() });
        expect(second.status).toBe('noop');
        expect(second.revision).toBe(first.revision);
        // Nur die probe hat gefetcht, kein pull.
        expect(log.length).toBe(fetchesAfterFirst + 1);

        const after = await canonicalNQuads(await dumpGraph(handle, handle.iri.importGraph('quelle')));
        expect(after).toBe(before);
        expect((await getConnector(handle, 'quelle'))?.lastRun?.summary).toContain('kein Import nötig');
    });

    it('geänderte Revision führt zu einem sauberen Replace', async () => {
        routes.set(url, textResponse('<https://example.org/alt> <https://schema.org/name> "Alt" .', 'text/turtle'));
        const first = await syncConnector(handle, 'quelle', { fetchImpl, now: fixedClock() });

        routes.set(url, textResponse('<https://example.org/neu> <https://schema.org/name> "Neu" .', 'text/turtle'));
        const second = await syncConnector(handle, 'quelle', { fetchImpl, now: fixedClock() });
        expect(second.status).toBe('imported');
        expect(second.revision).not.toBe(first.revision);
        expect(second.removed).toBeGreaterThan(0);

        const quads = await dumpGraph(handle, handle.iri.importGraph('quelle'));
        expect(quads.some(q => q.subject.value === 'https://example.org/neu')).toBe(true);
        expect(quads.some(q => q.subject.value === 'https://example.org/alt')).toBe(false);
        expect((await getConnector(handle, 'quelle'))?.revision).toBe(second.revision);
    });

    it('kaputte N-Quads-Zeilen werden zeilengenau quarantäniert, der Rest importiert', async () => {
        const nqUrl = 'https://example.org/data.nq';
        await createConnector(handle, { id: 'nq', name: 'NQ', kind: 'rdf-file', locator: nqUrl });
        routes.set(nqUrl, textResponse(
            '<https://example.org/g1> <https://schema.org/name> "Gut eins" .\n' +
            'DAS IST KEIN RDF @@@\n' +
            '<https://example.org/g2> <https://schema.org/name> "Gut zwei" .',
            'application/n-quads',
        ));

        const result = await syncConnector(handle, 'nq', { fetchImpl, now: fixedClock() });
        expect(result.status).toBe('imported');
        expect(result.quarantined).toHaveLength(1);
        expect(result.quarantined[0].source).toBe(`${nqUrl}:2`);

        const quads = await dumpGraph(handle, handle.iri.importGraph('nq'));
        expect(quads.some(q => q.subject.value === 'https://example.org/g1')).toBe(true);
        expect(quads.some(q => q.subject.value === 'https://example.org/g2')).toBe(true);

        // Fehlerbericht liegt als schema:error am Lauf-Knoten in graph/meta.
        const view = await getConnector(handle, 'nq');
        expect(view?.lastRun?.errors).toHaveLength(1);
        expect(view?.lastRun?.errors[0]).toContain(`${nqUrl}:2`);
    });

    it('komplett fehlerhaftes Turtle bricht den Import nicht ab — Quelle wird quarantäniert', async () => {
        routes.set(url, textResponse('@prefix kaputt @@@ nix RDF', 'text/turtle'));
        const result = await syncConnector(handle, 'quelle', { fetchImpl, now: fixedClock() });
        expect(result.status).toBe('imported');
        expect(result.quarantined).toHaveLength(1);
        expect(result.quarantined[0].reason).toContain('text/turtle');
        // Der Fehlerbericht ist in der UI sichtbar (über die Meta-Ansicht).
        const view = await getConnector(handle, 'quelle');
        expect(view?.lastRun?.errors[0]).toContain('Parst nicht');
    });

    it('Netzwerkfehler führen zu status failed, der letzte Import bleibt unangetastet', async () => {
        routes.set(url, textResponse('<https://example.org/e1> <https://schema.org/name> "Eins" .', 'text/turtle'));
        await syncConnector(handle, 'quelle', { fetchImpl, now: fixedClock() });
        const before = await canonicalNQuads(await dumpGraph(handle, handle.iri.importGraph('quelle')));

        routes.set(url, () => new Response('kaputt', { status: 500 }));
        const result = await syncConnector(handle, 'quelle', { fetchImpl, now: fixedClock() });
        expect(result.status).toBe('failed');
        expect(result.message).toContain('HTTP 500');
        expect((await getConnector(handle, 'quelle'))?.syncState).toBe('error');

        const after = await canonicalNQuads(await dumpGraph(handle, handle.iri.importGraph('quelle')));
        expect(after).toBe(before);
    });

    it('Löschen entfernt Meta-Knoten UND Import-Graphen', async () => {
        routes.set(url, textResponse('<https://example.org/e1> <https://schema.org/name> "Eins" .', 'text/turtle'));
        await syncConnector(handle, 'quelle', { fetchImpl, now: fixedClock() });
        const importGraph = handle.iri.importGraph('quelle');
        expect((await handle.store.graphs()).map(g => g.value)).toContain(importGraph);

        expect(await deleteConnector(handle, 'quelle')).toBe(true);
        expect(await getConnector(handle, 'quelle')).toBeNull();
        expect((await handle.store.graphs()).map(g => g.value)).not.toContain(importGraph);
        expect(await deleteConnector(handle, 'quelle')).toBe(false);
    });
});

describe('github-rdf-Connector: prima-materia-Referenzfall', () => {
    let handle: GraphHandle;
    let routes: Map<string, Route>;
    let log: string[];
    let fetchImpl: typeof fetch;

    const api = 'https://api.github.com/repos/pajew-ski/prima-materia';
    const sha = 'abc123def456';

    beforeEach(async () => {
        handle = { store: new OxigraphStore(), iri: createIriFactory(INSTANCE_BASE) };
        routes = new Map();
        log = [];
        fetchImpl = makeFetchStub(routes, log);

        routes.set(api, jsonResponse({ default_branch: 'main' }));
        routes.set(`${api}/commits/main`, jsonResponse({ sha }));
        // Der kanonische Locator ohne konfigurierten Ref pinnt über HEAD
        // (Default-Branch) — die GitHub-API löst HEAD zum Commit auf.
        routes.set(`${api}/commits/HEAD`, jsonResponse({ sha }));
        routes.set(`${api}/git/trees/${sha}?recursive=1`, jsonResponse({
            truncated: false,
            tree: [
                { path: 'README.md', type: 'blob', size: 10 },
                { path: 'ontology/gut.ttl', type: 'blob', size: 100 },
                { path: 'ontology/kaputt.ttl', type: 'blob', size: 50 },
                { path: 'ontology/blank-a.ttl', type: 'blob', size: 60 },
                { path: 'ontology/blank-b.ttl', type: 'blob', size: 60 },
                { path: 'woanders/ausserhalb.ttl', type: 'blob', size: 40 },
                { path: 'ontology', type: 'tree' },
            ],
        }));
        const raw = (path: string) => `https://raw.githubusercontent.com/pajew-ski/prima-materia/${sha}/${path}`;
        routes.set(raw('ontology/gut.ttl'), textResponse(
            '<https://example.org/begriff> <https://schema.org/name> "Begriff" .',
            'text/plain',
        ));
        routes.set(raw('ontology/kaputt.ttl'), textResponse('@@@ definitiv kein turtle', 'text/plain'));
        routes.set(raw('ontology/blank-a.ttl'), textResponse('_:b0 <https://schema.org/name> "A" .', 'text/plain'));
        routes.set(raw('ontology/blank-b.ttl'), textResponse('_:b0 <https://schema.org/name> "B" .', 'text/plain'));

        await createConnector(handle, {
            id: 'prima-materia',
            name: 'prima-materia',
            kind: 'github-rdf',
            locator: githubRdfConnector.locatorFor(
                githubRdfConnector.parseConfig({ repo: 'pajew-ski/prima-materia', path: 'ontology' }),
            ) as string,
        });
    });

    it('importiert commit-gepinnt, filtert auf den Ordner, quarantäniert kaputte Dateien einzeln', async () => {
        const result = await syncConnector(handle, 'prima-materia', { fetchImpl, now: fixedClock() });
        expect(result.status).toBe('imported');
        expect(result.revision).toBe(sha);

        // Nur die kaputte Datei ist quarantäniert — der Import lief weiter.
        expect(result.quarantined).toHaveLength(1);
        expect(result.quarantined[0].source).toBe('ontology/kaputt.ttl');

        // Jeder Datei-Abruf ist am Commit-SHA gepinnt, nie an einem Branch.
        const rawFetches = log.filter(u => u.includes('raw.githubusercontent.com'));
        expect(rawFetches.length).toBe(4);
        expect(rawFetches.every(u => u.includes(`/${sha}/`))).toBe(true);
        // Außerhalb des Ordners und Nicht-RDF wird nicht angefasst.
        expect(log.some(u => u.includes('ausserhalb.ttl') || u.includes('README.md'))).toBe(false);

        const quads = await dumpGraph(handle, handle.iri.importGraph('prima-materia'));
        expect(quads.some(q => q.object.value === 'Begriff')).toBe(true);

        // PROV: Quelle ist der kanonische Repo-Locator, Revision der SHA.
        const importGraph = handle.iri.importGraph('prima-materia');
        const prov = quads.filter(q => q.subject.value === importGraph);
        expect(prov.find(q => q.predicate.value === OW.revision)?.object.value).toBe(sha);
        expect(prov.find(q => q.predicate.value === PROV.wasDerivedFrom)?.object.value)
            .toContain('github.com/pajew-ski/prima-materia');
    });

    it('Blank Nodes aus verschiedenen Dateien kollidieren nicht', async () => {
        await syncConnector(handle, 'prima-materia', { fetchImpl, now: fixedClock() });
        const quads = await dumpGraph(handle, handle.iri.importGraph('prima-materia'));
        const blankSubjects = new Set(
            quads
                .filter(q => q.subject.termType === 'BlankNode' && q.predicate.value === SCHEMA.name)
                .map(q => q.subject.value),
        );
        // _:b0 aus blank-a.ttl und _:b0 aus blank-b.ttl bleiben zwei Knoten.
        expect(blankSubjects.size).toBe(2);
    });

    it('unveränderter Commit ist ein No-Op ohne Datei-Abrufe', async () => {
        await syncConnector(handle, 'prima-materia', { fetchImpl, now: fixedClock() });
        const rawBefore = log.filter(u => u.includes('raw.githubusercontent.com')).length;

        const second = await syncConnector(handle, 'prima-materia', { fetchImpl, now: fixedClock() });
        expect(second.status).toBe('noop');
        expect(log.filter(u => u.includes('raw.githubusercontent.com')).length).toBe(rawBefore);
    });

    it('Locator↔Config-Round-Trip ist verlustfrei', () => {
        const cases = [
            { repo: 'pajew-ski/prima-materia' },
            { repo: 'pajew-ski/prima-materia', ref: 'main' },
            { repo: 'pajew-ski/prima-materia', ref: 'v1.0', path: 'ontology/kern' },
            { repo: 'https://github.com/pajew-ski/prima-materia' },
            { repo: 'https://github.com/pajew-ski/prima-materia/tree/main/ontology' },
        ];
        for (const config of cases) {
            const parsed = githubRdfConnector.parseConfig(config);
            const locator = githubRdfConnector.locatorFor(parsed) as string;
            const back = githubRdfConnector.configFromLocator(locator) as { repo: string; ref?: string; path?: string };
            const target = parseRepoInput(githubRdfConnector.parseConfig(config) as { repo: string; ref?: string; path?: string });
            expect(back.repo).toBe(`${target.owner}/${target.repo}`);
            expect(parseRepoInput(back)).toEqual(target);
        }
        expect(() => parseRepoInput({ repo: 'https://gitlab.com/x/y' })).toThrow(/github\.com/);
        expect(() => parseRepoInput({ repo: 'nur-ein-wort' })).toThrow(/owner\/name/);
    });
});

describe('SSRF-Schutz des Connector-Fetch', () => {
    it('blockiert private Ziele, bevor irgendetwas gefetcht wird', async () => {
        const handle: GraphHandle = { store: new OxigraphStore(), iri: createIriFactory(INSTANCE_BASE) };
        const log: string[] = [];
        const fetchImpl = makeFetchStub(new Map(), log);
        await createConnector(handle, {
            id: 'boese',
            name: 'Metadaten-Dienst',
            kind: 'rdf-file',
            locator: 'http://169.254.169.254/latest/meta-data',
        });
        const result = await syncConnector(handle, 'boese', { fetchImpl });
        expect(result.status).toBe('failed');
        expect(result.message).toContain('blockiert');
        expect(log).toHaveLength(0);
    });

    it('validiert jeden Redirect-Hop gegen die SSRF-Politik', async () => {
        const routes = new Map<string, Route>();
        routes.set('https://example.org/umleitung', () =>
            new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/geheim' } }));
        const log: string[] = [];
        const guarded = createGuardedFetch({ fetchImpl: makeFetchStub(routes, log) });
        await expect(guarded('https://example.org/umleitung')).rejects.toThrow(/blockiert/);
        // Der öffentliche Hop wurde geholt, der private nie.
        expect(log).toEqual(['https://example.org/umleitung']);
    });

    it('lehnt Nicht-http(s)-Schemata und Redirect-Schleifen ab', async () => {
        const guarded = createGuardedFetch({ fetchImpl: makeFetchStub(new Map(), []) });
        await expect(guarded('file:///etc/passwd')).rejects.toThrow(ConnectorFetchError);

        const routes = new Map<string, Route>();
        routes.set('https://example.org/loop', () =>
            new Response(null, { status: 302, headers: { location: 'https://example.org/loop' } }));
        const looping = createGuardedFetch({ fetchImpl: makeFetchStub(routes, []), maxRedirects: 3 });
        await expect(looping('https://example.org/loop')).rejects.toThrow(/Redirects/);
    });
});

describe('Quad-Werkzeuge', () => {
    it('erkennt RDF-Formate an der Datei-Endung', () => {
        expect(rdfFormatForPath('a/b/kern.ttl')).toBe('text/turtle');
        expect(rdfFormatForPath('x.jsonld')).toBe('application/ld+json');
        expect(rdfFormatForPath('x.nq')).toBe('application/n-quads');
        expect(rdfFormatForPath('README.md')).toBeNull();
    });

    it('errät das Format notfalls durch Sniffing', () => {
        const jsonld = JSON.stringify({ '@id': 'https://example.org/x', 'https://schema.org/name': 'X' });
        const parsed = parseRdfLenient(jsonld, { source: 'anonym' });
        expect(parsed.quads).toHaveLength(1);
        expect(parsed.format).toBe('application/ld+json');

        const garbage = parseRdfLenient('%%% nichts %%%', { source: 'anonym' });
        expect(garbage.quads).toHaveLength(0);
        expect(garbage.quarantined).toHaveLength(1);
    });

    it('benennt Blank Nodes pro Quelle mit Präfix um und hält die Zuordnung stabil', () => {
        // Oxigraph vergibt beim Parsen eigene Blank-Node-Labels; das
        // Präfix macht die Disjunktheit zwischen Quellen deterministisch.
        const quads = parseRdf('_:a <https://example.org/p> _:b . _:a <https://example.org/q> "x" .', { format: 'text/turtle' });
        const relabelled = relabelBlankNodes(quads, 'f7');
        for (const q of relabelled) {
            expect(q.subject.value.startsWith('f7_')).toBe(true);
        }
        // Gleiches Eingangs-Label ⇒ gleiches Ausgangs-Label …
        expect(relabelled[0].subject.value).toBe(relabelled[1].subject.value);
        // … verschiedene Labels bleiben verschieden.
        expect(relabelled[0].subject.value).not.toBe(relabelled[0].object.value);
    });
});

describe('Katalog: nur Implementiertes existiert (Invariante 10)', () => {
    it('führt genau rdf-file, github-rdf, obsidian-vault und json-canvas (M5)', () => {
        expect(listConnectorKinds().map(c => c.kind).sort()).toEqual(['github-rdf', 'json-canvas', 'obsidian-vault', 'rdf-file']);
        expect(getConnectorKind('git-backup')).toBeNull();
        expect(getConnectorKind('sparql-endpoint')).toBeNull();
        expect(getConnectorKind('rdf-file')).toBe(rdfFileConnector);
    });

    it('liefert JSON-Schemata für die Konfiguration', () => {
        for (const kind of listConnectorKinds()) {
            const schema = kind.configSchema();
            expect(schema).toHaveProperty('type', 'object');
        }
    });
});
