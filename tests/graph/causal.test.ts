// @vitest-environment node
/**
 * Abnahme C0 — Kausalmodell als Graph-Bürger (CAUSAL_LAYER_SPEC §16).
 *
 * Die Spec verlangt drei Dinge, und genau die stehen hier:
 *
 *  1. **Ontologie-CI grün** — erzwingt `bun run check:ontology` in CI;
 *     hier zusätzlich geprüft: die kausale Kante ist FREMDES Vokabular
 *     (RO_0002411) und taucht deshalb NICHT unter den ow:-Termen auf
 *     (Invariante C8).
 *  2. **Ein von Hand modellierter DAG ist per SPARQL abfragbar** — der
 *     Test schreibt ihn so, wie ein Mensch ihn im SPARQL-Editor schriebe
 *     (INSERT DATA mit RDF-1.2-Annotation) und liest ihn über den
 *     Produktivpfad zurück.
 *  3. **Die Layout-Blacklist hält** (Invariante 2): kein Präsentationswert
 *     im Kausal-Graphen, und die Shapes melden ihn, falls doch.
 *
 * Dazu, weil es sonst niemand merkt, bis es zu spät ist: Ein Modell
 * überlebt den Neustart (Snapshot-Layout) — ein von Hand modellierter DAG
 * hat keine Quelle, aus der er wiederherstellbar wäre.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Quad } from '@rdfjs/types';
import { OxigraphStore } from '@/lib/graph/store/oxigraph';
import { createIriFactory } from '@/lib/graph/iri';
import { namedNode } from '@/lib/graph/rdf';
import { OW, OW_VOCAB_BASE, RO, SPARQL_PREFIXES } from '@/lib/graph/vocab';
import {
    causalEdgeReifier,
    causalGraphsOf,
    causalModelIri,
    causalModelQuads,
    createCausalModel,
    deleteCausalModel,
    listCausalHypotheses,
    listCausalModels,
    readCausalModel,
} from '@/lib/graph/causal/model';
import { createVariable } from '@/lib/graph/observations/variables';
import { validateQuads } from '@/lib/graph/reasoning/shacl';
import { validateStoreGraphs } from '@/lib/graph/reasoning/run';
import { parseRdf } from '@/lib/graph/serialize/io';
import { snapshotFileForGraph, writeSnapshot, restoreSnapshot } from '@/lib/graph/serialize/snapshot';
import { createMemoryFileSystem } from '@/lib/platform/runtime/memfs';

const INSTANCE_BASE = 'urn:ow:11111111-2222-4333-8444-555555555555:';

function newHandle() {
    return { store: new OxigraphStore(), iri: createIriFactory(INSTANCE_BASE) };
}

function shapesQuads(): Quad[] {
    const dir = path.join(process.cwd(), 'ontology', 'shapes');
    return ['core.ttl', 'causal.ttl'].flatMap(name =>
        parseRdf(readFileSync(path.join(dir, name), 'utf-8'), { format: 'text/turtle' }));
}

async function dump(store: OxigraphStore, graphIri: string): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const q of store.dump(namedNode(graphIri))) quads.push(q);
    return quads;
}

const iri = createIriFactory(INSTANCE_BASE);
const variable = (id: string) => iri.entity('variable', id);

/**
 * Ein von Hand modellierter DAG, so wie ein Mensch ihn schreibt: drei
 * Variablen, zwei Kanten, eine davon mit Zeitversatz. Die Außentemperatur
 * wirkt auf beides — sie ist der Störfaktor, dessentwegen es die ganze
 * Übung gibt.
 */
function handWrittenUpdate(graph: string, modelIri: string): string {
    const fenster = variable('fenster-offen');
    const heizung = variable('heizenergie');
    const aussen = variable('aussentemperatur');
    const reifier = (from: string, to: string) => causalEdgeReifier(iri, 'wohnung', from, to);
    return `${SPARQL_PREFIXES}
        PREFIX obo: <http://purl.obolibrary.org/obo/>
        INSERT DATA {
            GRAPH <${graph}> {
                <${modelIri}> schema:hasPart <${fenster}>, <${heizung}>, <${aussen}> .
                <${fenster}> a ow:Variable ; schema:name "Fenster offen" .
                <${heizung}> a ow:Variable ; schema:name "Heizenergie" ; schema:unitText "kWh" .
                <${aussen}> a ow:Variable ; schema:name "Außentemperatur" ; schema:unitText "°C" .

                <${fenster}> obo:RO_0002411 <${heizung}> .
                <${aussen}>  obo:RO_0002411 <${heizung}> .
                <${aussen}>  obo:RO_0002411 <${fenster}> .

                <${reifier(fenster, heizung)}>
                    rdf:reifies <<( <${fenster}> obo:RO_0002411 <${heizung}> )>> ;
                    ow:edgeClass "asserted" ;
                    ow:evidenceLevel "hypothesis" ;
                    ow:temporalLag "PT15M"^^xsd:duration .
                <${reifier(aussen, heizung)}>
                    rdf:reifies <<( <${aussen}> obo:RO_0002411 <${heizung}> )>> ;
                    ow:edgeClass "structural" ;
                    ow:evidenceLevel "hypothesis" .
                <${reifier(aussen, fenster)}>
                    rdf:reifies <<( <${aussen}> obo:RO_0002411 <${fenster}> )>> ;
                    ow:edgeClass "hypothesis" ;
                    ow:evidenceLevel "hypothesis" .
            }
        }`;
}

async function modelWithDag() {
    const handle = newHandle();
    await createCausalModel(handle, {
        id: 'wohnung',
        name: 'Heizung in der Wohnung',
        now: new Date('2026-08-13T10:00:00.000Z'),
    });
    const graph = handle.iri.causalGraph('wohnung');
    await handle.store.update(handWrittenUpdate(graph, causalModelIri(handle.iri, 'wohnung')));
    return { handle, graph };
}

describe('Vokabular (Invariante C8: fremdes vor eigenem)', () => {
    it('nutzt für die Kante die OBO Relations Ontology, nicht einen eigenen Term', () => {
        expect(RO.causallyUpstreamOf).toBe('http://purl.obolibrary.org/obo/RO_0002411');
        const own = Object.values(OW).filter(term => /causal|cause|effect|upstream/i.test(term));
        // Erlaubt sind die Klammern um das Kausale — das Modell (C0), der
        // Lauf und seine Kennzahl (C4). Die RELATION selbst darf nicht
        // eigen sein: Sobald hier ein Term stünde, der zwei Variablen
        // verbindet, wäre Invariante C8 gebrochen.
        expect(own.sort()).toEqual([
            `${OW_VOCAB_BASE}CausalModel`,
            `${OW_VOCAB_BASE}CausalStudy`,
            `${OW_VOCAB_BASE}effectSize`,
        ]);
    });

    it('definiert nur, was über eine Kante ausgesagt wird', () => {
        for (const term of [OW.edgeClass, OW.temporalLag, OW.evidenceLevel]) {
            expect(term.startsWith(OW_VOCAB_BASE)).toBe(true);
        }
    });
});

describe('Kausalmodell als Graph-Bürger (§5)', () => {
    it('legt ein Modell als eigenen Named Graph an und liest es zurück', async () => {
        const handle = newHandle();
        const model = await createCausalModel(handle, { id: 'wohnung', name: 'Heizung in der Wohnung' });
        expect(model.graph).toBe(`${INSTANCE_BASE}graph/u/default/causal/wohnung`);
        expect(model.iri).toBe(`${INSTANCE_BASE}u/default/causal-model/wohnung`);
        expect(model.variables).toEqual([]);
        expect(model.edges).toEqual([]);

        const graphs = (await handle.store.graphs()).map(g => g.value);
        expect(causalGraphsOf(handle.iri, graphs)).toEqual([{ modelId: 'wohnung', graph: model.graph }]);
    });

    it('lehnt eine zweite Anlage derselben Kennung ab, statt still zu überschreiben', async () => {
        const handle = newHandle();
        await createCausalModel(handle, { id: 'wohnung', name: 'Erst' });
        await expect(createCausalModel(handle, { id: 'wohnung', name: 'Zweit' }))
            .rejects.toThrow(/existiert bereits/);
    });

    it('lehnt Kennungen ab, die keinen sauberen Graph-Namen ergeben', async () => {
        const handle = newHandle();
        for (const id of ['Wohnung', 'mit/slash', 'mit leerzeichen', '']) {
            await expect(createCausalModel(handle, { id, name: 'x' })).rejects.toThrow(/Ungültige Modell-Kennung/);
        }
    });

    it('entfernt ein Modell vollständig; ein zweites Löschen meldet ehrlich „nichts da"', async () => {
        const handle = newHandle();
        await createCausalModel(handle, { id: 'wohnung', name: 'Heizung' });
        expect(await deleteCausalModel(handle, 'wohnung')).toBe(true);
        expect(await deleteCausalModel(handle, 'wohnung')).toBe(false);
        expect(await listCausalModels(handle)).toEqual([]);
    });
});

describe('Abnahme: ein von Hand modellierter DAG ist per SPARQL abfragbar (§16 C0)', () => {
    it('findet Kanten samt Annotation über eine gewöhnliche SPARQL-Query', async () => {
        const { handle, graph } = await modelWithDag();
        const result = await handle.store.query(`${SPARQL_PREFIXES}
            SELECT ?from ?to ?class ?lag WHERE {
                GRAPH <${graph}> {
                    ?from <${RO.causallyUpstreamOf}> ?to .
                    ?r rdf:reifies <<( ?from <${RO.causallyUpstreamOf}> ?to )>> .
                    ?r ow:edgeClass ?class .
                    OPTIONAL { ?r ow:temporalLag ?lag }
                }
            } ORDER BY ?from ?to`, { defaultGraphs: [namedNode(graph)], namedGraphs: [namedNode(graph)] });
        expect(result.type).toBe('bindings');
        const rows: Array<Record<string, string>> = [];
        if (result.type === 'bindings') {
            for await (const row of result.bindings) {
                rows.push(Object.fromEntries(Object.entries(row).map(([key, term]) => [key, term.value])));
            }
        }
        expect(rows).toHaveLength(3);
        const lagged = rows.find(row => row.from.endsWith('fenster-offen'));
        expect(lagged?.class).toBe('asserted');
        expect(lagged?.lag).toBe('PT15M');
    });

    it('beantwortet die eigentliche Frage: welche Größen wirken auf die Heizenergie', async () => {
        const { handle, graph } = await modelWithDag();
        const result = await handle.store.query(`${SPARQL_PREFIXES}
            SELECT ?ursache WHERE {
                GRAPH <${graph}> { ?ursache <${RO.causallyUpstreamOf}> <${variable('heizenergie')}> }
            } ORDER BY ?ursache`, { defaultGraphs: [namedNode(graph)], namedGraphs: [namedNode(graph)] });
        const found: string[] = [];
        if (result.type === 'bindings') {
            for await (const row of result.bindings) found.push(row.ursache.value);
        }
        expect(found).toEqual([variable('aussentemperatur'), variable('fenster-offen')]);
    });

    it('liest denselben DAG über den Produktivpfad, mit Herkunft je Kante (Invariante C2)', async () => {
        const { handle } = await modelWithDag();
        const [model] = await listCausalModels(handle);
        expect(model.name).toBe('Heizung in der Wohnung');
        expect(model.variables.map(v => v.name)).toEqual(['Außentemperatur', 'Fenster offen', 'Heizenergie']);
        expect(model.variables.every(v => v.inModel)).toBe(true);
        expect(model.edges.map(edge => edge.edgeClass).sort()).toEqual(['asserted', 'hypothesis', 'structural']);
        const lagged = model.edges.find(edge => edge.from.endsWith('fenster-offen'));
        expect(lagged?.temporalLag).toBe('PT15M');
        expect(lagged?.evidenceLevel).toBe('hypothesis');
    });

    it('zeigt eine unannotierte Kante trotzdem — ohne Herkunft, aber nicht unsichtbar', async () => {
        const handle = newHandle();
        await createCausalModel(handle, { id: 'roh', name: 'Ohne Annotation' });
        const graph = handle.iri.causalGraph('roh');
        await handle.store.update(`
            INSERT DATA { GRAPH <${graph}> {
                <${variable('a')}> <${RO.causallyUpstreamOf}> <${variable('b')}> .
            } }`);
        const model = await readCausalModel(handle, { modelId: 'roh', graph });
        expect(model?.edges).toHaveLength(1);
        expect(model?.edges[0].edgeClass).toBeNull();
        // An einer Kante hängend, aber dem Modell nicht zugeordnet: sichtbar
        // gemacht statt verschwiegen.
        expect(model?.variables.every(v => !v.inModel)).toBe(true);
    });

    it('hält Hypothesen getrennt vom Modell (Invariante C2)', async () => {
        const { handle } = await modelWithDag();
        const hypothesesGraph = handle.iri.graph('causal-hypotheses');
        await handle.store.update(`${SPARQL_PREFIXES}
            INSERT DATA { GRAPH <${hypothesesGraph}> {
                <${variable('mondphase')}> <${RO.causallyUpstreamOf}> <${variable('heizenergie')}> .
                <${iri.entity('link', 'causal/hypo/1')}>
                    rdf:reifies <<( <${variable('mondphase')}> <${RO.causallyUpstreamOf}> <${variable('heizenergie')}> )>> ;
                    ow:edgeClass "hypothesis" ; ow:evidenceLevel "hypothesis" .
            } }`);
        const hypotheses = await listCausalHypotheses(handle);
        expect(hypotheses).toHaveLength(1);
        expect(hypotheses[0].edgeClass).toBe('hypothesis');
        // Und im Modell taucht der Vorschlag nicht auf.
        const [model] = await listCausalModels(handle);
        expect(model.edges.some(edge => edge.from.includes('mondphase'))).toBe(false);
    });

    it('zeigt an einer Modellvariablen, ob sie überhaupt erfasst wird (C3-Brücke)', async () => {
        const { handle } = await modelWithDag();
        // Dieselbe Variablen-IRI, die im Modell steht, ist zugleich die
        // Beobachtungsgröße aus C3 — eine Identität, zwei Graphen.
        await createVariable(handle, {
            id: 'heizenergie',
            name: 'Heizenergie (Zähler)',
            sourceKind: 'home-assistant',
            source: 'sensor.heizenergie',
            kind: 'numeric',
            aggregation: 'mean',
            intervalSeconds: 300,
            unit: 'kWh',
            retentionDays: 0,
        });
        const [model] = await listCausalModels(handle);
        const heizung = model.variables.find(v => v.iri.endsWith('heizenergie'));
        const fenster = model.variables.find(v => v.iri.endsWith('fenster-offen'));
        expect(heizung?.observation).toEqual({ count: 0 });
        expect(fenster?.observation).toBeUndefined();
        // Der Name aus dem Modell gilt vor dem der Erfassung: Im Modell
        // benennt der Mensch, in der Erfassung die Quelle.
        expect(heizung?.name).toBe('Heizenergie');
    });

    it('verengt sich auf den Grant: ein nicht lesbarer Graph ist kein Modell', async () => {
        const { handle } = await modelWithDag();
        expect(await listCausalModels(handle, { allowedGraphs: [] })).toEqual([]);
    });
});

describe('SHACL-Shapes für kausale Kanten (§5, C0)', () => {
    it('nimmt einen sauber annotierten DAG ohne Befund ab', async () => {
        const { handle, graph } = await modelWithDag();
        const report = await validateQuads(shapesQuads(), await dump(handle.store, graph));
        expect(report.results.filter(r => r.severity.endsWith('Violation'))).toEqual([]);
    });

    it('meldet eine erfundene Kantenklasse als Violation', async () => {
        const report = await validateQuads(shapesQuads(), causalModelQuads(iri, {
            id: 'kaputt',
            name: 'Kaputt',
            edges: [{
                from: variable('a'),
                to: variable('b'),
                // Bewusst außerhalb der vier Klassen aus Invariante C2.
                edgeClass: 'vermutlich' as 'asserted',
            }],
        }));
        expect(report.conforms).toBe(false);
        expect(report.results.some(r => r.message.includes('Kantenklasse'))).toBe(true);
    });

    it('meldet einen Zeitversatz, der keine Dauer ist', async () => {
        const quads = causalModelQuads(iri, {
            id: 'lag',
            name: 'Lag',
            edges: [{ from: variable('a'), to: variable('b'), edgeClass: 'asserted' }],
        }).map(quad => quad);
        const reifier = causalEdgeReifier(iri, 'lag', variable('a'), variable('b'));
        const extra = parseRdf(
            `<${reifier}> <${OW.temporalLag}> "15 Minuten" .`,
            { format: 'application/n-triples' },
        );
        const report = await validateQuads(shapesQuads(), [...quads, ...extra]);
        expect(report.results.some(r => r.message.includes('ISO-8601-Dauer'))).toBe(true);
    });

    it('meldet eine Kante ohne Herkunftsklasse, sobald sie Evidenz behauptet', async () => {
        const reifier = causalEdgeReifier(iri, 'evidenz', variable('a'), variable('b'));
        const report = await validateQuads(shapesQuads(), parseRdf(
            `<${reifier}> <${OW.evidenceLevel}> "estimated" .`,
            { format: 'application/n-triples' },
        ));
        expect(report.results.some(r => r.message.includes('Herkunftsklasse'))).toBe(true);
    });

    it('validiert Kausal-Graphen auch über den On-demand-Pfad des Explorers', async () => {
        const { handle, graph } = await modelWithDag();
        const report = await handle.store.load(shapesQuads(), namedNode(handle.iri.sharedGraph('shapes')), { replace: true })
            .then(() => validateStoreGraphs(handle, [graph]));
        expect(report.graphs).toEqual([graph]);
    });
});

describe('Invariante 2: kein Layout im Kausal-Graphen', () => {
    it('schreibt keinen einzigen Präsentationswert', async () => {
        const { handle, graph } = await modelWithDag();
        const banned = ['color', 'position', 'xPosition', 'yPosition', 'width', 'height', 'viewport', 'zoom'];
        for (const quad of await dump(handle.store, graph)) {
            for (const term of banned) {
                expect(quad.predicate.value.toLowerCase()).not.toContain(term.toLowerCase());
            }
        }
    });

    it('meldet einen doch hineingeschriebenen Layout-Wert als Violation', async () => {
        const { handle, graph } = await modelWithDag();
        await handle.store.update(`${SPARQL_PREFIXES}
            INSERT DATA { GRAPH <${graph}> {
                <${causalModelIri(iri, 'wohnung')}> ow:xPosition 120 .
            } }`);
        const report = await validateQuads(shapesQuads(), await dump(handle.store, graph));
        expect(report.conforms).toBe(false);
        expect(report.results.some(r => r.message.includes('Layout-Wert'))).toBe(true);
    });
});

describe('Persistenz: ein Modell überlebt den Neustart', () => {
    it('bekommt eine eigene Snapshot-Datei und kommt vollständig zurück', async () => {
        expect(snapshotFileForGraph(`${INSTANCE_BASE}graph/u/default/causal/wohnung`, INSTANCE_BASE))
            .toBe('causal/wohnung.nq');
        expect(snapshotFileForGraph(`${INSTANCE_BASE}graph/u/default/causal-hypotheses`, INSTANCE_BASE))
            .toBe('causal-hypotheses.nq');

        const { handle, graph } = await modelWithDag();
        const files = createMemoryFileSystem();
        await writeSnapshot(handle.store, files, '/snapshot', INSTANCE_BASE);

        const restored = { store: new OxigraphStore(), iri: createIriFactory(INSTANCE_BASE) };
        await restoreSnapshot(restored.store, files, '/snapshot');
        const [model] = await listCausalModels(restored);
        expect(model.graph).toBe(graph);
        expect(model.edges).toHaveLength(3);
        expect(model.edges.find(edge => edge.from.endsWith('fenster-offen'))?.temporalLag).toBe('PT15M');
    });
});
