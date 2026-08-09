// @vitest-environment node
/**
 * M8-Abnahme Multi-Hop-Retrieval (GRAPH_CORE_SPEC §7.5, §13):
 *
 *  1. Ein Retrieval mit `maxHops: 2` über einen Seed liefert reproduzierbar
 *     dieselbe Knotenmenge in derselben Score-Reihenfolge — auch über zwei
 *     unabhängig (und in anderer Reihenfolge) befüllte Stores.
 *  2. `explain` weist jeden aufgenommenen Knoten aus: Seeds tragen ihre
 *     Quellen, expandierte Knoten Hop + Entdeckungs-Kante (`via`) + alle
 *     Score-Bestandteile; `seedStrategy`/`hopsUsed`/`prunedAt` sind gefüllt.
 *  3. Hub-Kappung greift nachweislich an einem Tag mit über 100 Dokumenten
 *     (Default maxDegree 100); mit größerem maxDegree fließen die
 *     Dokumente wieder (Gegenprobe).
 *  4. Der linearisierte Kontext hält das Token-Budget ein und wird entlang
 *     der Score-Reihenfolge gekappt.
 *  5. `includeInferred: false` (Default) nutzt die M7-Inferenz-Graphen
 *     NICHT; erst auf Anforderung — inferierte Kanten sind markiert.
 *  6. Dataset-Klammer VOR der Expansion: presentation/acl/vocab sind nie
 *     Traversal-Raum; Kantengewichte (ow:weight am RDF-1.2-Reifier) und
 *     Richtungs-/Typ-Filter wirken; Retrieval-Profile sind ow:-Entitäten
 *     in graph/meta und per SPARQL abfragbar.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { Quad } from '@rdfjs/types';
import { OxigraphStore } from '@/lib/graph/store/oxigraph';
import { createIriFactory } from '@/lib/graph/iri';
import { factory, literal, namedNode, typedLiteral } from '@/lib/graph/rdf';
import { OW, RDF, SCHEMA, SKOS, SPARQL_PREFIXES, DCTERMS } from '@/lib/graph/vocab';
import {
    buildFulltextIndexForGraphs,
    estimateTokens,
    retrievalDataset,
    retrieve,
    seedPhase,
    withRetrievalDefaults,
    type GraphHandle,
    type RetrievalResult,
} from '@/lib/graph/search/retrieval';
import {
    createRetrievalProfile,
    deleteRetrievalProfile,
    getRetrievalProfile,
    listRetrievalProfiles,
} from '@/lib/graph/search/profiles';
import { VectorIndex } from '@/lib/graph/search/vector';

const INSTANCE_BASE = 'urn:ow:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee:';
const nn = namedNode;

interface Fixture {
    handle: GraphHandle;
    quads: Quad[];
}

const iri = createIriFactory(INSTANCE_BASE);
const W = nn(iri.graph('workspace'));

const doc = (id: string) => iri.entity('doc', id);
const task = (id: string) => iri.entity('task', id);
const tag = (id: string) => iri.entity('tag', id);

/**
 * Wissensgraph der Tests:
 *
 *   doc-start —linksTo→ doc-mitte —linksTo→ doc-ende
 *   doc-start —linksTo(ow:weight 3)→ doc-schwer
 *   doc-start —about→ tag-klein ←about— doc-nachbar
 *   task-a —blockedBy→ task-b; doc-start —about→ tag-hub ←about— 120 Docs
 *   presentation-Graph enthält einen Köder (darf nie auftauchen)
 */
function buildQuads(): Quad[] {
    const quads: Quad[] = [];
    const add = (s: string, p: string, o: Parameters<typeof factory.quad>[2], g = W) =>
        quads.push(factory.quad(nn(s), nn(p), o, g));

    const namedDoc = (id: string, name: string, created: string) => {
        add(doc(id), RDF.type, nn(OW.Document));
        add(doc(id), SCHEMA.name, literal(name));
        add(doc(id), DCTERMS.created, typedLiteral.dateTime(created));
    };
    namedDoc('start', 'Startdokument Retrieval', '2026-08-01T10:00:00Z');
    namedDoc('mitte', 'Mittelstück', '2026-08-02T10:00:00Z');
    namedDoc('ende', 'Endstück', '2026-08-03T10:00:00Z');
    namedDoc('schwer', 'Gewichtetes Ziel', '2026-08-02T10:00:00Z');
    namedDoc('nachbar', 'Nachbar über Tag', '2026-08-02T11:00:00Z');
    add(doc('start'), SCHEMA.text, literal('Der Ausgangspunkt der Traversierung mit reichlich Fließtext.'));

    add(doc('start'), OW.linksTo, nn(doc('mitte')));
    add(doc('mitte'), OW.linksTo, nn(doc('ende')));

    // Gewichtete Kante: RDF-1.2-Reifier mit ow:weight 3.
    add(doc('start'), OW.linksTo, nn(doc('schwer')));
    const reifier = iri.entity('link', 'start-schwer');
    add(reifier, RDF.reifies, factory.quad(nn(doc('start')), nn(OW.linksTo), nn(doc('schwer'))));
    add(reifier, OW.weight, typedLiteral.decimal(3));

    // Kleiner Tag (2 Dokumente) — normale Expansion.
    add(tag('klein'), RDF.type, nn(SKOS.Concept));
    add(tag('klein'), SKOS.prefLabel, literal('klein'));
    add(doc('start'), SCHEMA.about, nn(tag('klein')));
    add(doc('nachbar'), SCHEMA.about, nn(tag('klein')));

    // Hub-Tag mit 120 Dokumenten (Abnahme: Grad-Kappung > 100).
    add(tag('hub'), RDF.type, nn(SKOS.Concept));
    add(tag('hub'), SKOS.prefLabel, literal('hub'));
    add(doc('start'), SCHEMA.about, nn(tag('hub')));
    for (let i = 1; i <= 120; i++) {
        const id = `hubdoc-${String(i).padStart(3, '0')}`;
        add(doc(id), RDF.type, nn(OW.Document));
        add(doc(id), SCHEMA.name, literal(`Hub-Dokument ${i}`));
        add(doc(id), SCHEMA.about, nn(tag('hub')));
    }

    // Aufgabenkette für Richtungs- und Inferenz-Tests.
    add(task('a'), RDF.type, nn(OW.Task));
    add(task('a'), SCHEMA.name, literal('Aufgabe A'));
    add(task('b'), RDF.type, nn(OW.Task));
    add(task('b'), SCHEMA.name, literal('Aufgabe B'));
    add(task('a'), OW.blockedBy, nn(task('b')));

    // Köder im Presentation-Graphen: darf NIE im Retrieval auftauchen.
    const decoy = iri.entity('canvas-node', 'köder');
    quads.push(factory.quad(nn(decoy), nn(OW.rendersNode), nn(doc('start')), nn(iri.graph('presentation'))));
    quads.push(factory.quad(nn(decoy), nn(SCHEMA.name), literal('Köder-Layout'), nn(iri.graph('presentation'))));

    // Import-Graph für Provenienz/Connector-Ausweis.
    const importGraph = nn(iri.importGraph('prima'));
    const imported = iri.entity('doc', 'importiert');
    quads.push(factory.quad(nn(imported), nn(RDF.type), nn(OW.Document), importGraph));
    quads.push(factory.quad(nn(imported), nn(SCHEMA.name), literal('Importiertes Dokument'), importGraph));
    quads.push(factory.quad(nn(imported), nn(OW.linksTo), nn(doc('ende')), importGraph));

    return quads;
}

async function makeHandle(quads: Quad[]): Promise<GraphHandle> {
    const store = new OxigraphStore();
    const byGraph = new Map<string, Quad[]>();
    for (const q of quads) {
        const graph = q.graph.termType === 'NamedNode' ? q.graph.value : '';
        const list = byGraph.get(graph) ?? [];
        list.push(q);
        byGraph.set(graph, list);
    }
    for (const [graph, list] of byGraph) {
        await store.load(list, nn(graph));
    }
    return { store, iri };
}

let fixture: Fixture;

beforeAll(async () => {
    const quads = buildQuads();
    fixture = { handle: await makeHandle(quads), quads };
});

describe('Dataset-Klammer (§7.5/§17-Vorstufe)', () => {
    it('Traversal-Raum sind die Wissens-Graphen; presentation/acl nie, inferred nur auf Anforderung', async () => {
        const dataset = await retrievalDataset(fixture.handle, { includeInferred: false });
        expect(dataset).toContain(iri.graph('workspace'));
        expect(dataset).toContain(iri.importGraph('prima'));
        expect(dataset.some(g => g.endsWith('/presentation'))).toBe(false);
        expect(dataset.some(g => g.includes('/inferred/'))).toBe(false);
        expect(dataset.some(g => g.endsWith('graph/acl'))).toBe(false);
    });

    it('explizit angeforderte Graphen werden gegen die erlaubte Menge gefiltert (still)', async () => {
        const dataset = await retrievalDataset(fixture.handle, {
            graphs: [iri.graph('workspace'), iri.graph('presentation'), `${INSTANCE_BASE}graph/acl`],
            includeInferred: false,
        });
        expect(dataset).toEqual([iri.graph('workspace')]);
    });
});

describe('Seeding (§7.5 Phase 1)', () => {
    it('IRI-Seeds: existierende zählen, nicht existierende fallen still weg', async () => {
        const dataset = await retrievalDataset(fixture.handle, { includeInferred: false });
        const seeding = await seedPhase(fixture.handle, dataset, {
            iri: [doc('start'), `${INSTANCE_BASE}u/default/doc/gibt-es-nicht`],
        }, 10, {});
        expect(seeding.seeds.size).toBe(1);
        expect(seeding.seeds.get(doc('start'))?.score).toBe(1);
        expect(seeding.strategy).toBe('iri(1/2)');
    });

    it('Text-Seeds über den Volltext-Index, Scores auf max=1 normiert', async () => {
        const dataset = await retrievalDataset(fixture.handle, { includeInferred: false });
        const fulltext = await buildFulltextIndexForGraphs(fixture.handle, dataset);
        const seeding = await seedPhase(fixture.handle, dataset, { text: 'Startdokument' }, 5, { fulltext });
        expect(seeding.seeds.get(doc('start'))?.score).toBe(1);
        expect(seeding.strategy).toContain('text:volltext');
    });

    it('Vektor-Seeds nur mit Index; ohne Index ehrliche Notiz statt leerer Attrappe', async () => {
        const dataset = await retrievalDataset(fixture.handle, { includeInferred: false });
        const without = await seedPhase(fixture.handle, dataset, { vector: [1, 0] }, 5, {});
        expect(without.seeds.size).toBe(0);
        expect(without.notes.join(' ')).toContain('Vektor-Seeding übersprungen');

        const vector = new VectorIndex();
        vector.add(doc('mitte'), iri.graph('workspace'), [1, 0]);
        vector.finalize();
        const withIndex = await seedPhase(fixture.handle, dataset, { vector: [1, 0] }, 5, { vector });
        expect(withIndex.seeds.get(doc('mitte'))?.score).toBe(1);
        expect(withIndex.strategy).toBe('vektor(1)');
    });
});

describe('Abnahme 1: Reproduzierbarkeit bei maxHops: 2', () => {
    it('zwei Läufe liefern identische Knotenmenge und Score-Reihenfolge', async () => {
        const request = { seeds: { iri: [doc('start')] }, maxHops: 2 };
        const first = await retrieve(fixture.handle, request);
        const second = await retrieve(fixture.handle, request);
        expect(first.nodes.length).toBeGreaterThan(3);
        expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });

    it('auch über einen zweiten, in umgekehrter Reihenfolge befüllten Store', async () => {
        const shuffled = await makeHandle([...fixture.quads].reverse());
        const request = { seeds: { iri: [doc('start')] }, maxHops: 2 };
        const first = await retrieve(fixture.handle, request);
        const second = await retrieve(shuffled, request);
        expect(JSON.stringify(first.nodes)).toBe(JSON.stringify(second.nodes));
        expect(JSON.stringify(first.edges)).toBe(JSON.stringify(second.edges));
    });

    it('maxHops 2 erreicht die zweite Ebene, nicht die dritte', async () => {
        const result = await retrieve(fixture.handle, {
            seeds: { iri: [doc('mitte')] },
            maxHops: 1,
            direction: 'out',
        });
        expect(result.nodes.map(n => n.iri)).toContain(doc('ende'));
        const twoHops = await retrieve(fixture.handle, {
            seeds: { iri: [doc('start')] },
            maxHops: 2,
            direction: 'out',
        });
        expect(twoHops.nodes.map(n => n.iri)).toContain(doc('ende'));
        expect(twoHops.explain.hopsUsed).toBe(2);
        const oneHop = await retrieve(fixture.handle, {
            seeds: { iri: [doc('start')] },
            maxHops: 1,
            direction: 'out',
        });
        expect(oneHop.nodes.map(n => n.iri)).not.toContain(doc('ende'));
    });
});

describe('Abnahme 2: explain weist jeden aufgenommenen Knoten aus', () => {
    let result: RetrievalResult;
    beforeAll(async () => {
        result = await retrieve(fixture.handle, { seeds: { iri: [doc('start')] }, maxHops: 2 });
    });

    it('Seeds tragen Quellen, expandierte Knoten via + Hop', () => {
        const seed = result.nodes.find(n => n.iri === doc('start'));
        expect(seed?.seed).toEqual(['iri']);
        expect(seed?.hop).toBe(0);
        for (const node of result.nodes) {
            expect(node.hop).toBeGreaterThanOrEqual(0);
            expect(node.hop).toBeLessThanOrEqual(2);
            if (node.hop > 0) {
                expect(node.via, `via fehlt an ${node.iri}`).toBeDefined();
                expect(result.nodes.some(other => other.iri === node.via!.from)).toBe(true);
            }
            expect(node.scoreParts.seed).toBeGreaterThan(0);
            expect(node.scoreParts.decay).toBeGreaterThan(0);
            expect(node.scoreParts.centrality).toBeGreaterThanOrEqual(1);
            expect(node.scoreParts.recency).toBeGreaterThan(0);
        }
    });

    it('seedStrategy und hopsUsed sind gefüllt, Scores monoton sortiert', () => {
        expect(result.explain.seedStrategy).toBe('iri(1/1)');
        expect(result.explain.hopsUsed).toBe(2);
        for (let i = 1; i < result.nodes.length; i++) {
            expect(result.nodes[i - 1].score).toBeGreaterThanOrEqual(result.nodes[i].score);
        }
    });

    it('provenance nennt Quell-Graph und Connector für jeden Knoten', async () => {
        const withImport = await retrieve(fixture.handle, {
            seeds: { iri: [doc('ende')] },
            maxHops: 1,
            direction: 'both',
        });
        expect(withImport.provenance).toHaveLength(withImport.nodes.length);
        const imported = withImport.provenance.find(p => p.iri === iri.entity('doc', 'importiert'));
        expect(imported?.sourceGraph).toBe(iri.importGraph('prima'));
        expect(imported?.connector).toBe('prima');
        const native = withImport.provenance.find(p => p.iri === doc('ende'));
        expect(native?.sourceGraph).toBe(iri.graph('workspace'));
        expect(native?.connector).toBeUndefined();
    });
});

describe('Abnahme 3: Hub-Kappung an einem Tag mit über 100 Dokumenten', () => {
    it('Default maxDegree 100: die 120 Hub-Dokumente fluten das Ergebnis nicht', async () => {
        const result = await retrieve(fixture.handle, {
            seeds: { iri: [doc('start')] },
            maxHops: 2,
            maxNodes: 200,
        });
        expect(result.explain.prunedAt).toContain(tag('hub'));
        const hubDocs = result.nodes.filter(n => n.iri.includes('/doc/hubdoc-'));
        expect(hubDocs).toHaveLength(0);
        // Der Hub selbst bleibt Ergebnis (er wurde erreicht) …
        expect(result.nodes.map(n => n.iri)).toContain(tag('hub'));
        // … und der kleine Tag expandiert normal weiter.
        expect(result.nodes.map(n => n.iri)).toContain(doc('nachbar'));
    });

    it('Gegenprobe: mit maxDegree 200 fließen die Hub-Dokumente', async () => {
        const result = await retrieve(fixture.handle, {
            seeds: { iri: [doc('start')] },
            maxHops: 2,
            maxNodes: 200,
            maxDegree: 200,
        });
        expect(result.nodes.filter(n => n.iri.includes('/doc/hubdoc-')).length).toBeGreaterThan(100);
        expect(result.explain.prunedAt ?? []).not.toContain(tag('hub'));
    });
});

describe('Abnahme 4: Token-Budget des linearisierten Kontexts', () => {
    it('der Kontext hält das Budget ein und kappt entlang der Score-Reihenfolge', async () => {
        const full = await retrieve(fixture.handle, {
            seeds: { iri: [doc('start')] },
            maxHops: 2,
            format: 'context',
            tokenBudget: 10_000,
        });
        expect(full.context).toBeDefined();
        expect(full.context).toContain('[1]');
        expect(estimateTokens(full.context!)).toBeLessThanOrEqual(10_000);

        const tight = await retrieve(fixture.handle, {
            seeds: { iri: [doc('start')] },
            maxHops: 2,
            format: 'context',
            tokenBudget: 120,
        });
        expect(estimateTokens(tight.context!)).toBeLessThanOrEqual(120);
        expect(tight.truncated).toBe(true);
        expect(tight.explain.notes?.join(' ')).toContain('Token-Budget');
        // Kappung entlang der Score-Reihenfolge: der bestbewertete Knoten bleibt.
        expect(tight.context).toContain('[1]');
        expect(estimateTokens(tight.context!)).toBeLessThan(estimateTokens(full.context!));
    });

    it('format context liefert keine Kanten, format subgraph keinen Kontext', async () => {
        const contextOnly = await retrieve(fixture.handle, {
            seeds: { iri: [doc('start')] }, maxHops: 1, format: 'context',
        });
        expect(contextOnly.edges).toHaveLength(0);
        expect(contextOnly.context).toBeDefined();
        const subgraphOnly = await retrieve(fixture.handle, {
            seeds: { iri: [doc('start')] }, maxHops: 1, format: 'subgraph',
        });
        expect(subgraphOnly.context).toBeUndefined();
        expect(subgraphOnly.edges.length).toBeGreaterThan(0);
    });
});

describe('Abnahme 5: includeInferred (M7-Anbindung)', () => {
    beforeAll(async () => {
        // Inferenz-Graph wie vom M7-Reasoner: die inverse blocks-Kante.
        await fixture.handle.store.load(
            [factory.quad(nn(task('b')), nn(OW.blocks), nn(task('a')), nn(iri.inferredGraph('workspace')))],
            nn(iri.inferredGraph('workspace')),
        );
    });

    it('Default false: keine inferierte Kante im Ergebnis', async () => {
        const result = await retrieve(fixture.handle, { seeds: { iri: [task('a')] }, maxHops: 1 });
        expect(result.edges.some(e => e.inferred)).toBe(false);
        expect(result.edges.some(e => e.p === OW.blocks)).toBe(false);
    });

    it('true: inferierte Kante erscheint, als inferiert markiert', async () => {
        const result = await retrieve(fixture.handle, {
            seeds: { iri: [task('a')] }, maxHops: 1, includeInferred: true,
        });
        const inferred = result.edges.find(e => e.p === OW.blocks);
        expect(inferred).toBeDefined();
        expect(inferred!.inferred).toBe(true);
        expect(inferred!.graph).toBe(iri.inferredGraph('workspace'));
    });
});

describe('Steuerung der Expansion (§7.5 Phase 2/3)', () => {
    it('Richtung out folgt nur s→o: vom Mittelstück aus ist start unsichtbar', async () => {
        const result = await retrieve(fixture.handle, {
            seeds: { iri: [doc('mitte')] }, maxHops: 1, direction: 'out',
        });
        const iris = result.nodes.map(n => n.iri);
        expect(iris).toContain(doc('ende'));
        expect(iris).not.toContain(doc('start'));
        const inbound = await retrieve(fixture.handle, {
            seeds: { iri: [doc('mitte')] }, maxHops: 1, direction: 'in',
        });
        expect(inbound.nodes.map(n => n.iri)).toContain(doc('start'));
        expect(inbound.nodes.map(n => n.iri)).not.toContain(doc('ende'));
    });

    it('edgeTypes.exclude stoppt die Expansion über das Prädikat', async () => {
        const result = await retrieve(fixture.handle, {
            seeds: { iri: [doc('start')] },
            maxHops: 1,
            edgeTypes: { exclude: [SCHEMA.about] },
        });
        expect(result.nodes.map(n => n.iri)).not.toContain(tag('klein'));
        expect(result.nodes.map(n => n.iri)).toContain(doc('mitte'));
    });

    it('nodeTypes.exclude hält Knoten dieses Typs aus dem Ergebnis', async () => {
        const result = await retrieve(fixture.handle, {
            seeds: { iri: [doc('start')] },
            maxHops: 2,
            nodeTypes: { exclude: [SKOS.Concept] },
        });
        expect(result.nodes.some(n => n.types.includes(SKOS.Concept))).toBe(false);
        expect(result.nodes.map(n => n.iri)).toContain(doc('mitte'));
    });

    it('rdf:type ist per Default keine Wissens-Kante (Klassen-Knoten bleiben draußen)', async () => {
        const result = await retrieve(fixture.handle, { seeds: { iri: [doc('start')] }, maxHops: 2 });
        expect(result.nodes.map(n => n.iri)).not.toContain(OW.Document);
        expect(result.edges.some(e => e.p === RDF.type)).toBe(false);
    });

    it('Kantengewicht (ow:weight am Reifier) hebt den Score des Ziels', async () => {
        const result = await retrieve(fixture.handle, {
            seeds: { iri: [doc('start')] }, maxHops: 1, direction: 'out',
        });
        const weighted = result.nodes.find(n => n.iri === doc('schwer'));
        const plain = result.nodes.find(n => n.iri === doc('mitte'));
        expect(weighted).toBeDefined();
        expect(plain).toBeDefined();
        expect(weighted!.scoreParts.edgeWeight).toBe(3);
        expect(plain!.scoreParts.edgeWeight).toBe(1);
        expect(weighted!.score).toBeGreaterThan(plain!.score);
    });

    it('maxNodes kappt hart und meldet truncated', async () => {
        const result = await retrieve(fixture.handle, {
            seeds: { iri: [doc('start')] }, maxHops: 2, maxNodes: 3,
        });
        expect(result.nodes).toHaveLength(3);
        expect(result.truncated).toBe(true);
    });

    it('der Köder aus graph/presentation taucht in keinem Ergebnis auf', async () => {
        const result = await retrieve(fixture.handle, {
            seeds: { iri: [doc('start')] }, maxHops: 3, maxNodes: 300, maxDegree: 500,
        });
        const decoy = iri.entity('canvas-node', 'köder');
        expect(result.nodes.some(n => n.iri === decoy)).toBe(false);
        expect(result.edges.some(e => e.s === decoy || e.o === decoy)).toBe(false);
    });
});

describe('Defaults (§7.5)', () => {
    it('withRetrievalDefaults füllt die Spec-Defaults und klemmt Grenzen', () => {
        const filled = withRetrievalDefaults({});
        expect(filled.maxHops).toBe(2);
        expect(filled.maxNodes).toBe(50);
        expect(filled.direction).toBe('both');
        expect(filled.decay).toBe(0.5);
        expect(filled.maxDegree).toBe(100);
        expect(filled.includeInferred).toBe(false);
        expect(withRetrievalDefaults({ maxHops: 99 }).maxHops).toBe(4);
        expect(withRetrievalDefaults({ decay: 7 }).decay).toBe(1);
    });
});

describe('Retrieval-Profile als Graph-Entitäten (§7.5)', () => {
    it('create → list → get → delete, Parameter überleben den Round-Trip', async () => {
        const handle = fixture.handle;
        const created = await createRetrievalProfile(handle, {
            id: 'nachbarschaft',
            name: 'Nachbarschaft',
            description: 'Zwei Hops um einen Fokusknoten.',
            config: { maxHops: 2, direction: 'out', decay: 0.7, unbekanntesFeld: true },
        });
        expect(created.iri).toBe(iri.entity('profile', 'nachbarschaft'));
        expect(created.config).toEqual({ maxHops: 2, direction: 'out', decay: 0.7 });

        const listed = await listRetrievalProfiles(handle);
        expect(listed.map(p => p.id)).toContain('nachbarschaft');

        const loaded = await getRetrievalProfile(handle, 'nachbarschaft');
        expect(loaded?.config.decay).toBe(0.7);
        expect(loaded?.description).toBe('Zwei Hops um einen Fokusknoten.');

        expect(await deleteRetrievalProfile(handle, 'nachbarschaft')).toBe(true);
        expect(await getRetrievalProfile(handle, 'nachbarschaft')).toBeNull();
    });

    it('Profile sind selbst abfragbar (ow:RetrievalProfile in graph/meta per SPARQL)', async () => {
        const handle = fixture.handle;
        await createRetrievalProfile(handle, {
            id: 'sparql-sichtbar',
            name: 'Sichtbar per SPARQL',
            config: { maxHops: 1 },
        });
        const result = await handle.store.query(`${SPARQL_PREFIXES}
            ASK { GRAPH <${iri.sharedGraph('meta')}> { ?p a ow:RetrievalProfile ; schema:name "Sichtbar per SPARQL" } }`);
        expect(result.type).toBe('boolean');
        if (result.type === 'boolean') expect(result.value).toBe(true);
        await deleteRetrievalProfile(handle, 'sparql-sichtbar');
    });

    it('Profil-Parameter speisen retrieve() (Basis + feldweise Overrides)', async () => {
        const handle = fixture.handle;
        const profile = await createRetrievalProfile(handle, {
            id: 'basis',
            name: 'Basis',
            config: { maxHops: 1, direction: 'out' },
        });
        const result = await retrieve(handle, {
            ...profile.config,
            seeds: { iri: [doc('start')] },
            maxNodes: 5,
        });
        expect(result.explain.hopsUsed).toBeLessThanOrEqual(1);
        expect(result.nodes.length).toBeLessThanOrEqual(5);
        await deleteRetrievalProfile(handle, 'basis');
    });
});
