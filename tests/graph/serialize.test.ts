// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { OxigraphStore } from '../../src/lib/graph/store/oxigraph';
import { canonicalNQuads, hashCanonical, isIsomorphic } from '../../src/lib/graph/serialize/canonical';
import { parseRdf, serializeRdf } from '../../src/lib/graph/serialize/io';
import { writeSnapshot, restoreSnapshot, snapshotFileForGraph } from '../../src/lib/graph/serialize/snapshot';
import { createMemoryFileSystem } from '../../src/lib/platform/runtime/memfs';
import { namedNode, literal, quad, blankNode } from '../../src/lib/graph/rdf';
import type { Quad } from '@rdfjs/types';

const BASE = 'urn:ow:00000000-0000-4000-8000-000000000000:';
const WORKSPACE = namedNode(`${BASE}graph/u/default/workspace`);

async function collect(iterable: AsyncIterable<Quad>): Promise<Quad[]> {
    const out: Quad[] = [];
    for await (const q of iterable) out.push(q);
    return out;
}

/** Turtle mit Blank Nodes, Sprach-Literalen, Datentypen und Umlauten. */
const TURTLE_FIXTURE = `
@prefix ex: <urn:ex:> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

ex:doc1 ex:title "Über Ontologien"@de ;
    ex:created "2026-08-08T10:00:00Z"^^xsd:dateTime ;
    ex:author [ ex:name "Anonyma" ; ex:knows [ ex:name "Zweite" ] ] .

ex:doc2 ex:title "Second"@en ;
    ex:linksTo ex:doc1 .

_:standalone ex:comment "freistehender Blank Node" .
`;

describe('M0-Abnahme: Round-Trip und Determinismus', () => {
    it('Turtle → Store → N-Quads → Store ist RDF-isomorph inkl. Blank Nodes', async () => {
        const parsed = parseRdf(TURTLE_FIXTURE, { format: 'text/turtle' });
        expect(parsed.length).toBeGreaterThan(5);

        const store1 = new OxigraphStore();
        await store1.load(parsed, WORKSPACE);
        const dumped = await collect(store1.dump(WORKSPACE));

        const nquads = await canonicalNQuads(dumped);
        const reparsed = parseRdf(nquads, { format: 'application/n-quads' });

        const store2 = new OxigraphStore();
        await store2.load(reparsed, WORKSPACE);
        const dumped2 = await collect(store2.dump(WORKSPACE));

        expect(await isIsomorphic(dumped, dumped2)).toBe(true);
        expect(dumped2).toHaveLength(dumped.length);
    });

    it('zweimaliger Dump desselben Zustands ist byte-identisch', async () => {
        const parsed = parseRdf(TURTLE_FIXTURE, { format: 'text/turtle' });
        const store = new OxigraphStore();
        await store.load(parsed, WORKSPACE);

        const first = await canonicalNQuads(await collect(store.dump(WORKSPACE)));
        const second = await canonicalNQuads(await collect(store.dump(WORKSPACE)));
        expect(second).toBe(first);
    });

    it('isomorphe Datasets mit permutierten Blank-Node-Labels kanonisieren identisch', async () => {
        const a = parseRdf(TURTLE_FIXTURE, { format: 'text/turtle' });
        // Derselbe Inhalt, andere Blank-Node-Labels (zweiter Parse vergibt neue).
        const b = parseRdf(TURTLE_FIXTURE, { format: 'text/turtle' });
        const canonA = await canonicalNQuads(a);
        const canonB = await canonicalNQuads(b);
        expect(canonA).toBe(canonB);
        expect(canonA).toContain('_:c14n');
    });

    it('unterschiedliche Datasets kanonisieren unterschiedlich', async () => {
        const a = [quad(namedNode('urn:ex:a'), namedNode('urn:ex:p'), literal('x'), WORKSPACE)];
        const b = [quad(namedNode('urn:ex:a'), namedNode('urn:ex:p'), literal('y'), WORKSPACE)];
        expect(await isIsomorphic(a, b)).toBe(false);
    });

    it('lehnt Blank Nodes innerhalb von Triple Terms mit klarem Fehler ab', async () => {
        const inner = quad(blankNode('inner'), namedNode('urn:ex:p'), literal('x'));
        const outer = quad(namedNode('urn:ex:r'), namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies'), inner, WORKSPACE);
        await expect(canonicalNQuads([outer])).rejects.toThrow(/Triple Terms/);
    });

    it('Triple Terms ohne Blank Nodes serialisieren deterministisch', async () => {
        const inner = quad(namedNode('urn:ex:a'), namedNode('urn:ex:p'), literal('x'));
        const outer = quad(namedNode('urn:ex:r'), namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies'), inner, WORKSPACE);
        const canonical = await canonicalNQuads([outer]);
        expect(canonical).toContain('<<( <urn:ex:a> <urn:ex:p> "x" )>>');
        // Reparse über Oxigraph funktioniert.
        const reparsed = parseRdf(canonical, { format: 'application/n-quads' });
        expect(reparsed).toHaveLength(1);
    });

    it('Literal-Escaping überlebt den Round-Trip', async () => {
        const tricky = quad(
            namedNode('urn:ex:esc'),
            namedNode('urn:ex:p'),
            literal('Zeile1\nZeile2\t"quoted"\\backslash', 'de'),
            WORKSPACE,
        );
        const canonical = await canonicalNQuads([tricky]);
        const reparsed = parseRdf(canonical, { format: 'application/n-quads' });
        expect(reparsed).toHaveLength(1);
        expect(reparsed[0].object.value).toBe('Zeile1\nZeile2\t"quoted"\\backslash');
    });
});

describe('Format-IO', () => {
    it('serialisiert und parst Turtle, TriG, JSON-LD und N-Quads', async () => {
        const quads = [
            quad(namedNode('urn:ex:a'), namedNode('urn:ex:p'), literal('hallo', 'de'), WORKSPACE),
            quad(namedNode('urn:ex:a'), namedNode('urn:ex:knows'), namedNode('urn:ex:b'), WORKSPACE),
        ];
        for (const format of ['text/turtle', 'text/trig', 'application/ld+json', 'application/n-quads'] as const) {
            const text = serializeRdf(quads, format);
            const back = parseRdf(text, { format });
            expect(back, format).toHaveLength(2);
        }
    });
});

describe('Snapshot (data/graph-Layout)', () => {
    it('bildet Graph-IRIs auf das Dateilayout aus SPEC §8.1 ab', () => {
        expect(snapshotFileForGraph(`${BASE}graph/u/default/workspace`, BASE)).toBe('workspace.nq');
        expect(snapshotFileForGraph(`${BASE}graph/u/default/presentation`, BASE)).toBe('presentation.nq');
        expect(snapshotFileForGraph(`${BASE}graph/u/default/import/prima-materia`, BASE)).toBe('import/prima-materia.nq');
        expect(snapshotFileForGraph(`${BASE}graph/meta`, BASE)).toBe('meta.nq');
        expect(snapshotFileForGraph(`${BASE}graph/u/michael/workspace`, BASE)).toBe('u/michael/workspace.nq');
        // Nicht persistiert: vocab (aus ontology/), inferred (reproduzierbar), acl.
        expect(snapshotFileForGraph(`${BASE}graph/vocab`, BASE)).toBeNull();
        expect(snapshotFileForGraph(`${BASE}graph/u/default/inferred/public`, BASE)).toBeNull();
        expect(snapshotFileForGraph(`${BASE}graph/acl`, BASE)).toBeNull();
        expect(snapshotFileForGraph('urn:fremd:graph', BASE)).toBeNull();
    });

    it('write → restore → write ist byte-identisch (Manifest + Dateien)', async () => {
        const store = new OxigraphStore();
        await store.load(parseRdf(TURTLE_FIXTURE, { format: 'text/turtle' }), WORKSPACE);
        await store.load(
            [quad(namedNode('urn:ex:meta'), namedNode('urn:ex:p'), literal('m'))],
            namedNode(`${BASE}graph/meta`),
        );

        const fs1 = createMemoryFileSystem();
        await writeSnapshot(store, fs1, '/data/graph', BASE);
        expect(fs1.files.has('/data/graph/workspace.nq')).toBe(true);
        expect(fs1.files.has('/data/graph/meta.nq')).toBe(true);
        expect(fs1.files.has('/data/graph/manifest.json')).toBe(true);

        const restored = new OxigraphStore();
        const report = await restoreSnapshot(restored, fs1, '/data/graph');
        expect(report).not.toBeNull();

        const fs2 = createMemoryFileSystem();
        await writeSnapshot(restored, fs2, '/data/graph', BASE);
        expect(Object.fromEntries(fs2.files)).toEqual(Object.fromEntries(fs1.files));
    });

    it('entfernt verwaiste .nq-Dateien beim Schreiben', async () => {
        const store = new OxigraphStore();
        await store.load([quad(namedNode('urn:ex:a'), namedNode('urn:ex:p'), literal('x'))], WORKSPACE);
        const fs = createMemoryFileSystem();
        fs.files.set('/data/graph/import/verwaist.nq', '<urn:ex:alt> <urn:ex:p> "alt" .\n');
        const report = await writeSnapshot(store, fs, '/data/graph', BASE);
        expect(report.removedStale).toContain('import/verwaist.nq');
        expect(fs.files.has('/data/graph/import/verwaist.nq')).toBe(false);
    });

    it('hashCanonical ist stabil', async () => {
        const canonical = await canonicalNQuads([
            quad(namedNode('urn:ex:a'), namedNode('urn:ex:p'), literal('x'), WORKSPACE),
        ]);
        expect(await hashCanonical(canonical)).toBe(await hashCanonical(canonical));
        expect(await hashCanonical(canonical)).toMatch(/^[0-9a-f]{64}$/);
    });
});
