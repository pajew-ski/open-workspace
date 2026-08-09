// @vitest-environment node
/**
 * M7-Abnahme Reasoning (GRAPH_CORE_SPEC §7.3, §13):
 *
 *  1. `ow:blockedBy`/`ow:blocks` und `skos:broader`-Transitivität werden
 *     nachweislich inferiert.
 *  2. Kein inferiertes Tripel landet je in `graph/workspace` — der
 *     Workspace-Graph ist nach einem Reasoning-Lauf byte-identisch.
 *  3. Materialisierung ersetzt `graph/<u>/inferred/<scope>` vollständig
 *     (kein Merge): weggefallene Behauptungen hinterlassen keine Leichen.
 *  4. Scope-Partitionierung (Inferenz-Leak, §7.3 verbindlich): eine
 *     private Aussage plus eine öffentliche Regel hinterlässt im
 *     öffentlichen Inferenz-Graphen KEINE Spur.
 *  5. Der Reasoner läuft nach jedem Import (Sync-Runner) und auf
 *     Anforderung; PROV dokumentiert jeden Lauf; `inferred/*` wird nie
 *     persistiert und bleibt aus dem Default-Dataset ausgeschlossen.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Quad } from '@rdfjs/types';
import { OxigraphStore } from '@/lib/graph/store/oxigraph';
import { createIriFactory } from '@/lib/graph/iri';
import { factory, literal, namedNode } from '@/lib/graph/rdf';
import { OW, OWL, PREFIXES, PROV, RDF, SCHEMA, SKOS } from '@/lib/graph/vocab';
import { deriveOwlRlInferences } from '@/lib/graph/reasoning/owl-rl';
import { inferredTriples, reasoningStatus, runReasoning, workspaceScopeGraphs } from '@/lib/graph/reasoning/run';
import { parseRdf } from '@/lib/graph/serialize/io';
import { canonicalNQuads } from '@/lib/graph/serialize/canonical';
import { snapshotFileForGraph } from '@/lib/graph/serialize/snapshot';
import { resolveDataset } from '@/lib/graph/sparql/protocol';
import { createConnector } from '@/lib/graph/connectors/registry';
import { syncConnector } from '@/lib/graph/connectors/sync';

const INSTANCE_BASE = 'urn:ow:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee:';
const RDFS_SUBCLASS = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const RDFS_SUBPROP = 'http://www.w3.org/2000/01/rdf-schema#subPropertyOf';
const RDFS_DOMAIN = 'http://www.w3.org/2000/01/rdf-schema#domain';
const RDFS_RANGE = 'http://www.w3.org/2000/01/rdf-schema#range';
const OWL_TRANSITIVE = `${PREFIXES.owl}TransitiveProperty`;
const OWL_SYMMETRIC = `${PREFIXES.owl}SymmetricProperty`;

const nn = namedNode;
const triple = (s: string, p: string, o: string | ReturnType<typeof literal>) =>
    factory.quad(nn(s), nn(p), typeof o === 'string' ? nn(o) : o);

function lines(triples: ReturnType<typeof deriveOwlRlInferences>): string[] {
    return triples.map(t => `${t.subject.value} ${t.predicate.value} ${t.object.value}`);
}

/** Vokabular wie im Bootstrap: ow.ttl + ontology/rules/*.ttl. */
function vocabQuads(): Quad[] {
    const ow = readFileSync(path.join(process.cwd(), 'ontology', 'ow.ttl'), 'utf-8');
    const rules = readFileSync(path.join(process.cwd(), 'ontology', 'rules', 'reasoning.ttl'), 'utf-8');
    return [...parseRdf(ow, { format: 'text/turtle' }), ...parseRdf(rules, { format: 'text/turtle' })];
}

describe('OWL-RL-Regelmenge (deriveOwlRlInferences, §7.3-Fragment)', () => {
    it('owl:inverseOf: blockedBy erzeugt blocks — und umgekehrt', () => {
        const schema = [triple(OW.blockedBy, OWL.inverseOf, OW.blocks)];
        const out = lines(deriveOwlRlInferences(schema, [
            triple('urn:t:1', OW.blockedBy, 'urn:t:2'),
            triple('urn:t:3', OW.blocks, 'urn:t:4'),
        ]));
        expect(out).toContain(`urn:t:2 ${OW.blocks} urn:t:1`);
        expect(out).toContain(`urn:t:4 ${OW.blockedBy} urn:t:3`);
    });

    it('owl:TransitiveProperty: skos:broader wird über mehrere Hops geschlossen', () => {
        const schema = [triple(SKOS.broader, RDF.type, OWL_TRANSITIVE)];
        const out = lines(deriveOwlRlInferences(schema, [
            triple('urn:tag:a', SKOS.broader, 'urn:tag:b'),
            triple('urn:tag:b', SKOS.broader, 'urn:tag:c'),
            triple('urn:tag:c', SKOS.broader, 'urn:tag:d'),
        ]));
        expect(out).toContain(`urn:tag:a ${SKOS.broader} urn:tag:c`);
        expect(out).toContain(`urn:tag:a ${SKOS.broader} urn:tag:d`);
        expect(out).toContain(`urn:tag:b ${SKOS.broader} urn:tag:d`);
        expect(out).toHaveLength(3);
    });

    it('rdfs:subClassOf: Typ-Vererbung inkl. Hierarchie-Transitivität', () => {
        const schema = [
            triple('urn:c:kind', RDFS_SUBCLASS, 'urn:c:mittel'),
            triple('urn:c:mittel', RDFS_SUBCLASS, 'urn:c:ober'),
        ];
        const out = lines(deriveOwlRlInferences(schema, [triple('urn:x', RDF.type, 'urn:c:kind')]));
        expect(out).toContain(`urn:x ${RDF.type} urn:c:mittel`);
        expect(out).toContain(`urn:x ${RDF.type} urn:c:ober`);
    });

    it('rdfs:subPropertyOf und owl:equivalentProperty vererben Aussagen', () => {
        const schema = [
            triple('urn:p:spitz', RDFS_SUBPROP, 'urn:p:breit'),
            triple('urn:p:breit', OWL.equivalentProperty, 'urn:p:gleich'),
        ];
        const out = lines(deriveOwlRlInferences(schema, [triple('urn:a', 'urn:p:spitz', 'urn:b')]));
        expect(out).toContain(`urn:a urn:p:breit urn:b`);
        expect(out).toContain(`urn:a urn:p:gleich urn:b`);
    });

    it('owl:equivalentClass wirkt beidseitig auf die Typisierung', () => {
        const schema = [triple('urn:c:a', OWL.equivalentClass, 'urn:c:b')];
        const out = lines(deriveOwlRlInferences(schema, [
            triple('urn:x', RDF.type, 'urn:c:a'),
            triple('urn:y', RDF.type, 'urn:c:b'),
        ]));
        expect(out).toContain(`urn:x ${RDF.type} urn:c:b`);
        expect(out).toContain(`urn:y ${RDF.type} urn:c:a`);
    });

    it('rdfs:domain/range typisieren Subjekt und Objekt', () => {
        const schema = [
            triple('urn:p:hat', RDFS_DOMAIN, 'urn:c:halter'),
            triple('urn:p:hat', RDFS_RANGE, 'urn:c:gut'),
        ];
        const out = lines(deriveOwlRlInferences(schema, [triple('urn:a', 'urn:p:hat', 'urn:b')]));
        expect(out).toContain(`urn:a ${RDF.type} urn:c:halter`);
        expect(out).toContain(`urn:b ${RDF.type} urn:c:gut`);
    });

    it('owl:SymmetricProperty spiegelt Kanten', () => {
        const schema = [triple('urn:p:verwandt', RDF.type, OWL_SYMMETRIC)];
        const out = lines(deriveOwlRlInferences(schema, [triple('urn:a', 'urn:p:verwandt', 'urn:b')]));
        expect(out).toContain(`urn:b urn:p:verwandt urn:a`);
    });

    it('owl:sameAs: Symmetrie, Transitivität und Aussagen-Ersetzung, ohne x sameAs x', () => {
        const out = lines(deriveOwlRlInferences([], [
            triple('urn:a', OWL.sameAs, 'urn:b'),
            triple('urn:b', OWL.sameAs, 'urn:c'),
            triple('urn:a', SCHEMA.name, literal('Ding')),
            triple('urn:z', OW.linksTo, 'urn:c'),
        ]));
        expect(out).toContain(`urn:b ${OWL.sameAs} urn:a`);
        expect(out).toContain(`urn:a ${OWL.sameAs} urn:c`);
        expect(out).toContain(`urn:b ${SCHEMA.name} Ding`);
        expect(out).toContain(`urn:c ${SCHEMA.name} Ding`);
        expect(out).toContain(`urn:z ${OW.linksTo} urn:a`);
        expect(out.filter(l => /^urn:(a|b|c) .*sameAs urn:\1$/.test(l))).toHaveLength(0);
    });

    it('ist deterministisch und wiederholt keine behaupteten Tripel', () => {
        const schema = [triple(OW.blockedBy, OWL.inverseOf, OW.blocks)];
        const data = [
            triple('urn:t:1', OW.blockedBy, 'urn:t:2'),
            // Die Inverse ist bereits behauptet — darf nicht erneut auftauchen.
            triple('urn:t:2', OW.blocks, 'urn:t:1'),
        ];
        const first = lines(deriveOwlRlInferences(schema, data));
        const second = lines(deriveOwlRlInferences(schema, data));
        expect(first).toEqual(second);
        expect(first).toHaveLength(0);
    });
});

interface Handle {
    store: OxigraphStore;
    iri: ReturnType<typeof createIriFactory>;
}

async function makeHandle(): Promise<Handle> {
    const iri = createIriFactory(INSTANCE_BASE);
    const store = new OxigraphStore();
    await store.load(vocabQuads(), nn(iri.sharedGraph('vocab')), { replace: true });
    return { store, iri };
}

async function dump(handle: Handle, graphIri: string): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const q of handle.store.dump(nn(graphIri))) {
        quads.push(q);
    }
    return quads;
}

/** Workspace-Fixture: Abhängigkeit + Tag-Kette + private Aussage. */
async function seedWorkspace(handle: Handle): Promise<void> {
    const ws = handle.iri.graph('workspace');
    const g = nn(ws);
    const task1 = handle.iri.entity('task', 'task-1');
    const task2 = handle.iri.entity('task', 'task-2');
    const tag = (id: string) => handle.iri.entity('tag', id);
    await handle.store.load([
        factory.quad(nn(task1), nn(RDF.type), nn(OW.Task), g),
        factory.quad(nn(task2), nn(RDF.type), nn(OW.Task), g),
        factory.quad(nn(task1), nn(OW.blockedBy), nn(task2), g),
        factory.quad(nn(tag('a')), nn(SKOS.broader), nn(tag('b')), g),
        factory.quad(nn(tag('b')), nn(SKOS.broader), nn(tag('c')), g),
        // Private Aussage für den Leak-Test: sameAs-Brücke auf eine
        // öffentliche Entität, behauptet im PRIVATEN Graphen.
        factory.quad(nn(handle.iri.entity('doc', 'geheim')), nn(OWL.sameAs), nn(handle.iri.entity('doc', 'oeffentlich')), g),
        factory.quad(nn(handle.iri.entity('doc', 'geheim')), nn(SCHEMA.name), literal('Geheimplan'), g),
    ], g, { replace: true });
    // Öffentlicher Graph: nur die öffentliche Entität.
    const pub = nn(handle.iri.graph('public'));
    await handle.store.load([
        factory.quad(nn(handle.iri.entity('doc', 'oeffentlich')), nn(RDF.type), nn(OW.Document), pub),
    ], pub, { replace: true });
}

describe('Reasoning-Pipeline (runReasoning, Scope-Partitionierung §7.3)', () => {
    it('Abnahme: ow:blocks und skos:broader-Transitivität landen in graph/<u>/inferred/workspace', async () => {
        const handle = await makeHandle();
        await seedWorkspace(handle);
        const runs = await runReasoning(handle);
        expect(runs.map(r => r.scope).sort()).toEqual(['public', 'workspace']);

        const inferred = await dump(handle, handle.iri.inferredGraph('workspace'));
        const flat = inferred.map(q => `${q.subject.value} ${q.predicate.value} ${q.object.value}`);
        const task1 = handle.iri.entity('task', 'task-1');
        const task2 = handle.iri.entity('task', 'task-2');
        expect(flat).toContain(`${task2} ${OW.blocks} ${task1}`);
        expect(flat).toContain(`${handle.iri.entity('tag', 'a')} ${SKOS.broader} ${handle.iri.entity('tag', 'c')}`);
    });

    it('Abnahme: kein inferiertes Tripel landet je in graph/workspace (byte-identisch)', async () => {
        const handle = await makeHandle();
        await seedWorkspace(handle);
        const before = await canonicalNQuads(await dump(handle, handle.iri.graph('workspace')));
        await runReasoning(handle);
        const after = await canonicalNQuads(await dump(handle, handle.iri.graph('workspace')));
        expect(after).toBe(before);
    });

    it('vollständiger Replace: weggefallene Behauptungen hinterlassen keine Alt-Inferenzen', async () => {
        const handle = await makeHandle();
        await seedWorkspace(handle);
        await runReasoning(handle);

        // Abhängigkeit entfernen → ow:blocks muss aus dem Inferenz-Graphen
        // verschwinden (kein Merge, Invariante 3).
        const ws = nn(handle.iri.graph('workspace'));
        const remaining = (await dump(handle, ws.value)).filter(q => q.predicate.value !== OW.blockedBy);
        await handle.store.load(remaining, ws, { replace: true });
        await runReasoning(handle);

        const flat = (await dump(handle, handle.iri.inferredGraph('workspace')))
            .map(q => q.predicate.value);
        expect(flat).not.toContain(OW.blocks);
        // Die Tag-Transitivität bleibt (weiter behauptet).
        const objects = (await dump(handle, handle.iri.inferredGraph('workspace')))
            .map(q => `${q.subject.value} ${q.predicate.value} ${q.object.value}`);
        expect(objects).toContain(`${handle.iri.entity('tag', 'a')} ${SKOS.broader} ${handle.iri.entity('tag', 'c')}`);
    });

    it('Inferenz-Leak (§7.3 verbindlich): private Aussage + öffentliche Regel hinterlässt im öffentlichen Inferenz-Graphen keine Spur', async () => {
        const handle = await makeHandle();
        await seedWorkspace(handle);
        await runReasoning(handle);

        const geheim = handle.iri.entity('doc', 'geheim');
        const publicInferred = await dump(handle, handle.iri.inferredGraph('public'));
        for (const q of publicInferred) {
            expect(q.subject.value).not.toBe(geheim);
            expect(q.object.value).not.toBe(geheim);
            expect(q.object.value).not.toBe('Geheimplan');
        }
        // Zur Kontrolle: im Workspace-Scope IST die sameAs-Brücke wirksam
        // (die öffentliche Entität erbt den privaten Namen — sichtbar nur
        // für den Eigentümer).
        const wsInferred = (await dump(handle, handle.iri.inferredGraph('workspace')))
            .map(q => `${q.subject.value} ${q.predicate.value} ${q.object.value}`);
        expect(wsInferred).toContain(`${handle.iri.entity('doc', 'oeffentlich')} ${SCHEMA.name} Geheimplan`);
    });

    it('dokumentiert jeden Lauf mit PROV am Inferenz-Graphen', async () => {
        const handle = await makeHandle();
        await seedWorkspace(handle);
        await runReasoning(handle, { now: () => new Date(Date.UTC(2026, 7, 9, 12, 0, 0)) });
        const graphIri = handle.iri.inferredGraph('workspace');
        const flat = (await dump(handle, graphIri))
            .map(q => `${q.subject.value} ${q.predicate.value} ${q.object.value}`);
        expect(flat).toContain(`${graphIri} ${PROV.wasGeneratedBy} ${handle.iri.entity('activity', 'reasoning-workspace')}`);
        expect(flat).toContain(`${graphIri} ${PROV.generatedAtTime} 2026-08-09T12:00:00Z`);
    });

    it('Status und Tripel-Ansicht: reasoningStatus/inferredTriples zählen ohne PROV-Buchführung', async () => {
        const handle = await makeHandle();
        await seedWorkspace(handle);
        await runReasoning(handle);
        const status = await reasoningStatus(handle);
        const wsStatus = status.find(s => s.scope === 'workspace');
        expect(wsStatus?.generatedAt).toBeTruthy();
        expect(wsStatus?.inferred).toBeGreaterThan(0);
        const triples = await inferredTriples(handle, 'workspace');
        expect(triples).toHaveLength(wsStatus?.inferred ?? -1);
        expect(triples.every(t => t.subject !== handle.iri.inferredGraph('workspace'))).toBe(true);
    });

    it('inferred/* ist nie Snapshot-Bestandteil und nie im Default-Dataset', async () => {
        const handle = await makeHandle();
        await seedWorkspace(handle);
        await runReasoning(handle);
        const inferredGraph = handle.iri.inferredGraph('workspace');
        expect(snapshotFileForGraph(inferredGraph, INSTANCE_BASE)).toBeNull();

        const dataset = await resolveDataset(handle.store, handle.iri);
        expect(dataset.defaultGraphs.map(g => g.value)).not.toContain(inferredGraph);
        // Explizit angefordert bleibt er erreichbar (SPEC §3.3).
        const explicit = await resolveDataset(handle.store, handle.iri, { namedGraphUris: [inferredGraph] });
        expect(explicit.namedGraphs.map(g => g.value)).toContain(inferredGraph);
    });

    it('workspaceScopeGraphs: presentation, shapes, vocab, acl und inferred sind nie Reasoning-Input', async () => {
        const handle = await makeHandle();
        await seedWorkspace(handle);
        const all = [
            handle.iri.graph('workspace'), handle.iri.graph('public'), handle.iri.graph('presentation'),
            handle.iri.sharedGraph('meta'), handle.iri.sharedGraph('vocab'), handle.iri.sharedGraph('shapes'),
            handle.iri.sharedGraph('acl'), handle.iri.inferredGraph('workspace'), handle.iri.importGraph('quelle-1'),
        ];
        const scoped = workspaceScopeGraphs(handle.iri, all);
        expect(scoped).toEqual([
            handle.iri.sharedGraph('meta'),
            handle.iri.importGraph('quelle-1'),
            handle.iri.graph('public'),
            handle.iri.graph('workspace'),
        ].sort());
    });
});

describe('Reasoning nach Import (Sync-Runner, §7.3 „nach jedem Import")', () => {
    it('ein Connector-Import aktualisiert die Inferenz-Graphen', async () => {
        const handle = await makeHandle();
        await createConnector(handle, {
            id: 'rdf-quelle',
            name: 'Externe Quelle',
            kind: 'rdf-file',
            locator: 'https://example.org/daten.ttl',
        });
        const ttl = `@prefix ow: <${PREFIXES.ow}> .\n<urn:ext:a> ow:blockedBy <urn:ext:b> .\n`;
        const fetchStub = (async () => new Response(ttl, {
            status: 200,
            headers: { 'content-type': 'text/turtle' },
        })) as typeof fetch;

        const result = await syncConnector(handle, 'rdf-quelle', { fetchImpl: fetchStub });
        expect(result.status).toBe('imported');

        const inferred = (await dump(handle, handle.iri.inferredGraph('workspace')))
            .map(q => `${q.subject.value} ${q.predicate.value} ${q.object.value}`);
        expect(inferred).toContain(`urn:ext:b ${OW.blocks} urn:ext:a`);
    });
});
