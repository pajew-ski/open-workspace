// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { OxigraphStore } from '../../src/lib/graph/store/oxigraph';
import { MemoryGraphStore } from '../../src/lib/graph/store/memory';
import { GraphStoreError } from '../../src/lib/graph/store/types';
import { namedNode, literal, quad, typedLiteral } from '../../src/lib/graph/rdf';
import type { Quad } from '@rdfjs/types';

const g = (suffix: string) => namedNode(`urn:ow:00000000-0000-4000-8000-000000000000:graph/${suffix}`);
const WORKSPACE = g('u/default/workspace');
const OTHER = g('u/default/presentation');

const sampleQuads = (): Quad[] => [
    quad(namedNode('urn:ex:a'), namedNode('urn:ex:p'), typedLiteral.de('hallo Welt')),
    quad(namedNode('urn:ex:a'), namedNode('urn:ex:knows'), namedNode('urn:ex:b')),
    quad(namedNode('urn:ex:b'), namedNode('urn:ex:p'), literal('42', namedNode('http://www.w3.org/2001/XMLSchema#integer'))),
];

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const item of iterable) out.push(item);
    return out;
}

describe('OxigraphStore', () => {
    it('lädt Quads in einen Named Graph und beantwortet SPARQL', async () => {
        const store = new OxigraphStore();
        const report = await store.load(sampleQuads(), WORKSPACE);
        expect(report.added).toBe(3);
        expect(report.removed).toBe(0);

        const result = await store.query(
            `SELECT ?o WHERE { GRAPH <${WORKSPACE.value}> { <urn:ex:a> <urn:ex:p> ?o } }`,
        );
        expect(result.type).toBe('bindings');
        if (result.type !== 'bindings') return;
        const rows = await collect(result.bindings);
        expect(rows).toHaveLength(1);
        expect(rows[0].o.value).toBe('hallo Welt');
        expect(rows[0].o.termType).toBe('Literal');
    });

    it('erzwingt den Ziel-Graphen unabhängig vom Graph-Anteil der Quads', async () => {
        const store = new OxigraphStore();
        const foreign = quad(namedNode('urn:ex:x'), namedNode('urn:ex:p'), literal('y'), OTHER);
        await store.load([foreign], WORKSPACE);
        const inWorkspace = await collect(store.dump(WORKSPACE));
        const inOther = await collect(store.dump(OTHER));
        expect(inWorkspace).toHaveLength(1);
        expect(inOther).toHaveLength(0);
    });

    it('replace ersetzt den Graphen vollständig', async () => {
        const store = new OxigraphStore();
        await store.load(sampleQuads(), WORKSPACE);
        const replacement = [quad(namedNode('urn:ex:neu'), namedNode('urn:ex:p'), literal('ersetzt'))];
        const report = await store.load(replacement, WORKSPACE, { replace: true });
        expect(report.removed).toBe(3);
        expect(report.added).toBe(1);
        expect((await collect(store.dump(WORKSPACE)))).toHaveLength(1);
    });

    it('weist Updates in den Default-Graphen zurück (Invariante 4)', async () => {
        const store = new OxigraphStore();
        await expect(
            store.update('INSERT DATA { <urn:ex:a> <urn:ex:p> "ohne Graph" }'),
        ).rejects.toMatchObject({ code: 'DEFAULT_GRAPH_WRITE' });
        // Der Störversuch hinterlässt nichts.
        expect(await collect(store.dump())).toHaveLength(0);
    });

    it('erlaubt Updates mit GRAPH-Klausel', async () => {
        const store = new OxigraphStore();
        await store.update(`INSERT DATA { GRAPH <${WORKSPACE.value}> { <urn:ex:a> <urn:ex:p> "ok" } }`);
        expect(await collect(store.dump(WORKSPACE))).toHaveLength(1);
    });

    it('query() lehnt Updates ab, update() respektiert readOnly', async () => {
        const store = new OxigraphStore();
        await expect(
            store.query(`INSERT DATA { GRAPH <${WORKSPACE.value}> { <urn:ex:a> <urn:ex:p> "x" } }`),
        ).rejects.toMatchObject({ code: 'READ_ONLY' });
        await expect(
            store.update(`INSERT DATA { GRAPH <${WORKSPACE.value}> { <urn:ex:a> <urn:ex:p> "x" } }`, { readOnly: true }),
        ).rejects.toMatchObject({ code: 'READ_ONLY' });
    });

    it('Dataset-Klammern: defaultGraphs begrenzt die Query', async () => {
        const store = new OxigraphStore();
        await store.load(sampleQuads(), WORKSPACE);
        await store.load([quad(namedNode('urn:ex:geheim'), namedNode('urn:ex:p'), literal('privat'))], OTHER);

        const clamped = await store.query('SELECT ?s WHERE { ?s ?p ?o }', {
            defaultGraphs: [WORKSPACE],
            namedGraphs: [WORKSPACE],
        });
        if (clamped.type !== 'bindings') throw new Error('bindings erwartet');
        const subjects = (await collect(clamped.bindings)).map(r => r.s.value);
        expect(subjects).toContain('urn:ex:a');
        expect(subjects).not.toContain('urn:ex:geheim');

        // FROM im Query-Text wird durch die Klammer überschrieben.
        const bypass = await store.query(
            `SELECT ?s FROM <${OTHER.value}> WHERE { ?s ?p ?o }`,
            { defaultGraphs: [WORKSPACE], namedGraphs: [WORKSPACE] },
        );
        if (bypass.type !== 'bindings') throw new Error('bindings erwartet');
        const bypassSubjects = (await collect(bypass.bindings)).map(r => r.s.value);
        expect(bypassSubjects).not.toContain('urn:ex:geheim');
    });

    it('graphs() listet alle Named Graphs', async () => {
        const store = new OxigraphStore();
        await store.load(sampleQuads(), WORKSPACE);
        await store.load(sampleQuads(), OTHER);
        const graphs = await store.graphs();
        expect(graphs.map(n => n.value)).toEqual([OTHER.value, WORKSPACE.value].sort());
    });

    it('transaction rollt bei Fehlern vollständig zurück', async () => {
        const store = new OxigraphStore();
        await store.load(sampleQuads(), WORKSPACE);
        await expect(
            store.transaction(async tx => {
                await tx.load([quad(namedNode('urn:ex:tx'), namedNode('urn:ex:p'), literal('tx'))], OTHER);
                await tx.update(`DELETE WHERE { GRAPH <${WORKSPACE.value}> { ?s ?p ?o } }`);
                expect(await collect(tx.dump(WORKSPACE))).toHaveLength(0);
                throw new Error('absichtlich');
            }),
        ).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });
        expect(await collect(store.dump(WORKSPACE))).toHaveLength(3);
        expect(await collect(store.dump(OTHER))).toHaveLength(0);
    });

    it('transaction liefert das Ergebnis bei Erfolg und persistiert', async () => {
        const store = new OxigraphStore();
        const value = await store.transaction(async tx => {
            await tx.load(sampleQuads(), WORKSPACE);
            return 'fertig';
        });
        expect(value).toBe('fertig');
        expect(await collect(store.dump(WORKSPACE))).toHaveLength(3);
    });

    it('RDF 1.2: Reifier-Aussagen überleben Laden und Dump', async () => {
        const store = new OxigraphStore();
        await store.update(`PREFIX ex: <urn:ex:> PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
            INSERT DATA { GRAPH <${WORKSPACE.value}> {
                ex:r rdf:reifies <<( ex:a ex:p "x" )>> .
                ex:r ex:confidence 0.9 .
            } }`);
        const quads = await collect(store.dump(WORKSPACE));
        expect(quads).toHaveLength(2);
        const reifier = quads.find(q => q.object.termType === 'Quad');
        expect(reifier).toBeDefined();
        // Round-trip: Dump-Quads lassen sich wieder laden.
        const second = new OxigraphStore();
        await second.load(quads, WORKSPACE);
        expect(await collect(second.dump(WORKSPACE))).toHaveLength(2);
    });

    it('dump liefert strukturell RDF/JS-kompatible Terme', async () => {
        const store = new OxigraphStore();
        await store.load(sampleQuads(), WORKSPACE);
        const [first] = await collect(store.dump(WORKSPACE));
        expect(first.termType).toBe('Quad');
        expect(first.graph.termType).toBe('NamedNode');
        expect(typeof first.equals).toBe('function');
        if (first.object.termType === 'Literal') {
            expect(first.object.datatype.termType).toBe('NamedNode');
        }
    });
});

describe('MemoryGraphStore', () => {
    it('verhält sich bei load/dump/graphs wie der echte Store', async () => {
        const store = new MemoryGraphStore();
        const report = await store.load(sampleQuads(), WORKSPACE);
        expect(report.added).toBe(3);
        expect((await store.graphs()).map(n => n.value)).toEqual([WORKSPACE.value]);
        const again = await store.load(sampleQuads(), WORKSPACE, { replace: true });
        expect(again.removed).toBe(3);
        expect(again.added).toBe(3);
    });

    it('wirft bei SPARQL ehrlich NOT_SUPPORTED', async () => {
        const store = new MemoryGraphStore();
        await expect(store.query('SELECT * WHERE { ?s ?p ?o }')).rejects.toBeInstanceOf(GraphStoreError);
    });
});
