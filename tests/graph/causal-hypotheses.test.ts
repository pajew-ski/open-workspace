// @vitest-environment node
/**
 * Abnahme C6 — die neurosymbolische Schleife
 * (CAUSAL_LAYER_SPEC §8, §16, §19).
 *
 * §16 nennt zwei Bedingungen, und beide sind hier je ein eigener Test:
 *
 *  1. **Keine Hypothese erreicht ohne Filter den Studien-Pfad.** Die
 *     einzige Brücke vom Hypothesen-Graphen in ein Modell ist das
 *     Übernehmen — und es lehnt einen verworfenen Vorschlag ab, und zwar
 *     serverseitig, nicht durch einen ausgegrauten Knopf.
 *  2. **Ein temporal unmöglicher Vorschlag wird automatisch verworfen.**
 *     Ohne Zutun eines Menschen, im Lauf selbst, mit Begründung.
 *
 * Dazu, was §8 sonst verlangt: Zuschreibung auf Modell und
 * Prompt-Version, die vier harten Filter je einzeln, die konstruktive
 * Antwort bei fehlender Identifizierbarkeit, drei getrennte Quellen mit
 * Fehlerisolation, und der Quellenvergleich samt Widerspruch.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Quad } from '@rdfjs/types';
import { OxigraphStore } from '@/lib/graph/store/oxigraph';
import { createIriFactory } from '@/lib/graph/iri';
import { factory, literal, namedNode, typedLiteral } from '@/lib/graph/rdf';
import { parseRdf } from '@/lib/graph/serialize/io';
import { DCTERMS, OW, PROV, RDF, RO, SCHEMA, SOSA } from '@/lib/graph/vocab';
import { validateQuads } from '@/lib/graph/reasoning/shacl';
import { snapshotFileForGraph } from '@/lib/graph/serialize/snapshot';
import { createCausalModel, readCausalModel } from '@/lib/graph/causal/model';
import { applyStructureOperation, CausalEditError } from '@/lib/graph/causal/edit';
import { createVariable } from '@/lib/graph/observations/variables';
import { createFederatedEndpoint } from '@/lib/graph/federation/registry';
import { createDag } from '@/lib/graph/causal/dag';
import {
    applyFilters,
    lagSeconds,
    mayAdopt,
    type FilterContext,
} from '@/lib/graph/causal/filters';
import {
    buildProposalPrompt,
    buildWikidataQuery,
    parseProposalResponse,
    parseWikidataRows,
    proposeFromTopology,
    PROPOSAL_PROMPT_VERSION,
} from '@/lib/graph/causal/propose';
import {
    adoptHypothesis,
    discardHypothesis,
    hypothesesGraph,
    hypothesisId,
    hypothesisQuads,
    readHypotheses,
    replaceHypotheses,
    type HypothesisRecord,
} from '@/lib/graph/causal/hypothesis';
import { compareStructureSources } from '@/lib/graph/causal/compare';
import { runProposalSources } from '@/lib/graph/causal/propose.server';

// --- Das Sprachmodell wird gestellt, nicht gerufen -----------------------

/**
 * Antwort des Sprachmodells je Testfall. Der echte Weg läuft über
 * `resolveDefaultServerProvider` + `streamProviderChat`; hier steht ein
 * Stub davor, damit die Abnahme ohne Inferenz-Endpunkt läuft (und nicht
 * davon abhängt, was ein Modell heute gerade sagt).
 */
const llm: { answer: string | null; error?: string; model: string } = {
    answer: null,
    model: 'stub-modell-7b',
};

vi.mock('@/lib/ai/store.server', () => ({
    resolveDefaultServerProvider: async () => (llm.answer === null && !llm.error
        ? null
        : {
            resolved: {
                provider: { label: 'Stub', baseUrl: 'http://stub.invalid', defaultModel: llm.model },
                protocol: 'openai',
                context: 'server',
            },
            model: llm.model,
        }),
}));

vi.mock('@/lib/ai/client', () => ({
    streamProviderChat: async function* () {
        if (llm.error) throw new Error(llm.error);
        yield { type: 'text' as const, text: llm.answer ?? '' };
        yield { type: 'done' as const };
    },
}));

afterEach(() => {
    llm.answer = null;
    delete llm.error;
    llm.model = 'stub-modell-7b';
});

// --- Aufbau --------------------------------------------------------------

const INSTANCE_BASE = 'https://ws.example.org/id/';
const iri = createIriFactory(INSTANCE_BASE, 'alice');
const MODEL = 'wohnung';

const variable = (id: string) => iri.entity('variable', id);
const sensorIri = (id: string) => iri.entity('sensor', id);
const placeIri = (id: string) => iri.entity('place', id);
const deviceIri = (id: string) => iri.entity('device', id);

function shapes(): Quad[] {
    return ['core.ttl', 'causal.ttl'].flatMap(file =>
        parseRdf(readFileSync(path.join(process.cwd(), 'ontology', 'shapes', file), 'utf-8'),
            { format: 'text/turtle' }));
}

interface Fixture {
    store: OxigraphStore;
    iri: typeof iri;
}

async function freshStore(): Promise<Fixture> {
    const store = new OxigraphStore();
    await store.load(shapes(), namedNode(iri.sharedGraph('shapes')), { replace: true });
    return { store, iri };
}

interface VariableSpec {
    id: string;
    name: string;
    kind?: 'numeric' | 'binary';
    actuator?: boolean;
    place?: string;
    device?: string;
    observable?: string;
    sourceKind?: string;
    from?: string;
    through?: string;
    /** Ohne Erfassungsangaben ist die Größe nicht adjustierbar (C1/C3). */
    unobserved?: boolean;
}

/**
 * Legt eine erfasste Größe samt ihrer Messquelle an — genau so, wie es
 * `home-assistant` (C3) bzw. `rest-timeseries` (C5) tun: Struktur in den
 * Import-Graphen, Erfassungsregel nach `graph/meta`.
 */
async function seedVariable(fixture: Fixture, spec: VariableSpec): Promise<string> {
    const importGraph = namedNode(iri.importGraph(spec.sourceKind === 'rest-timeseries' ? 'wetter' : 'haus'));
    const sensor = sensorIri(spec.id);
    const quads: Quad[] = [
        factory.quad(
            namedNode(sensor),
            namedNode(RDF.type),
            namedNode(spec.actuator ? SOSA.Actuator : SOSA.Sensor),
            importGraph,
        ),
        factory.quad(namedNode(sensor), namedNode(SCHEMA.name), literal(spec.name), importGraph),
    ];
    if (spec.place) {
        quads.push(
            factory.quad(namedNode(sensor), namedNode(SCHEMA.location), namedNode(placeIri(spec.place)), importGraph),
            factory.quad(namedNode(placeIri(spec.place)), namedNode(RDF.type), namedNode(SCHEMA.Place), importGraph),
            factory.quad(namedNode(placeIri(spec.place)), namedNode(SCHEMA.name), literal(spec.place), importGraph),
        );
    }
    if (spec.device) {
        quads.push(
            factory.quad(namedNode(sensor), namedNode(SOSA.isHostedBy), namedNode(deviceIri(spec.device)), importGraph),
            factory.quad(namedNode(deviceIri(spec.device)), namedNode(SCHEMA.name), literal(spec.device), importGraph),
        );
    }
    if (spec.observable) {
        quads.push(
            factory.quad(namedNode(sensor), namedNode(SOSA.observes), namedNode(iri.entity('observable', spec.observable)), importGraph),
            factory.quad(namedNode(iri.entity('observable', spec.observable)), namedNode(RDF.type), namedNode(SOSA.ObservableProperty), importGraph),
            factory.quad(namedNode(iri.entity('observable', spec.observable)), namedNode(SCHEMA.name), literal(spec.observable), importGraph),
        );
    }
    const existing: Quad[] = [];
    for await (const quad of fixture.store.dump(importGraph)) existing.push(quad);
    await fixture.store.load([...existing, ...quads], importGraph, { replace: true });

    if (!spec.unobserved) {
        const view = await createVariable(fixture, {
            id: spec.id,
            name: spec.name,
            sourceKind: spec.sourceKind ?? 'home-assistant',
            source: `sensor.${spec.id}`,
            kind: spec.kind ?? 'numeric',
            aggregation: spec.kind === 'binary' ? 'last' : 'mean',
            intervalSeconds: 300,
            ...(spec.place ? { placeIri: placeIri(spec.place) } : {}),
            sensorIri: sensor,
        });
        if (spec.from || spec.through) {
            await createVariableCoverage(fixture, view.iri, spec.from, spec.through);
        }
    }
    return variable(spec.id);
}

/** Erfassungsfenster nachtragen — sonst kennt der Zeit-Filter keine Grenzen. */
async function createVariableCoverage(
    fixture: Fixture,
    variableIri: string,
    from?: string,
    through?: string,
): Promise<void> {
    const metaGraph = namedNode(iri.sharedGraph('meta'));
    const existing: Quad[] = [];
    for await (const quad of fixture.store.dump(metaGraph)) existing.push(quad);
    const added: Quad[] = [];
    if (from) {
        added.push(factory.quad(namedNode(variableIri), namedNode(OW.capturedFrom), typedLiteral.dateTime(from), metaGraph));
    }
    if (through) {
        added.push(factory.quad(namedNode(variableIri), namedNode(OW.capturedThrough), typedLiteral.dateTime(through), metaGraph));
    }
    await fixture.store.load([...existing, ...added], metaGraph, { replace: true });
}

async function seedModel(fixture: Fixture, members: readonly string[]): Promise<void> {
    await createCausalModel(fixture, { id: MODEL, name: 'Wohnung' });
    for (const member of members) {
        await applyStructureOperation(fixture, MODEL, { op: 'add-variable', iri: member });
    }
}

function jsonResults(rows: Array<Record<string, string>>): string {
    return JSON.stringify({
        head: { vars: ['causeLabel', 'effectLabel'] },
        results: {
            bindings: rows.map(row => Object.fromEntries(
                Object.entries(row).map(([key, value]) => [key, { type: 'literal', value, 'xml:lang': 'en' }]),
            )),
        },
    });
}

function stubFetch(body: string): typeof fetch {
    return (async () => new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/sparql-results+json' },
    })) as unknown as typeof fetch;
}

// --- 1. Die Filter, pur --------------------------------------------------

function contextOf(options: Partial<FilterContext> & { edges?: Array<[string, string]> } = {}): FilterContext {
    const edges = (options.edges ?? []).map(([from, to]) => ({ from, to }));
    const nodes = [...new Set(edges.flatMap(edge => [edge.from, edge.to]))];
    return {
        dag: options.dag ?? createDag({ nodes, edges }),
        observable: options.observable ?? new Set(nodes),
        coverage: options.coverage ?? new Map(),
        topology: options.topology ?? new Map(),
        label: options.label ?? ((node: string) => node),
    };
}

describe('Die symbolischen Filter (§8) — pur und einzeln', () => {
    it('verwirft einen Vorschlag, der einen Kreis schließt, mit dem Kreis im Klartext', () => {
        const context = contextOf({ edges: [['Heizung', 'Temperatur']] });
        const outcome = applyFilters(context, { from: 'Temperatur', to: 'Heizung' });
        expect(outcome.verdict).toBe('rejected');
        expect(outcome.rejectedBy).toBe('cycle');
        expect(outcome.reason).toContain('Heizung');
        expect(outcome.reason).toContain('Temperatur');
    });

    it('verwirft eine Größe, die ihre eigene Ursache wäre', () => {
        const outcome = applyFilters(contextOf(), { from: 'X', to: 'X' });
        expect(outcome.rejectedBy).toBe('cycle');
    });

    it('verwirft einen negativen Zeitversatz — dann ist die Richtung die falsche', () => {
        const outcome = applyFilters(contextOf(), { from: 'A', to: 'B', temporalLag: '-PT15M' });
        expect(outcome.rejectedBy).toBe('temporal');
        expect(outcome.reason).toContain('negativer Zeitversatz');
    });

    it('verwirft eine Dauer, die keine ISO-8601-Dauer ist', () => {
        const outcome = applyFilters(contextOf(), { from: 'A', to: 'B', temporalLag: '15 Minuten' });
        expect(outcome.rejectedBy).toBe('temporal');
    });

    it('verwirft, was zeitlich unmöglich ist: Ursache erfasst, nachdem die Wirkung endete', () => {
        const context = contextOf({
            coverage: new Map([
                ['A', { from: '2026-05-01T00:00:00.000Z' }],
                ['B', { through: '2026-02-01T00:00:00.000Z' }],
            ]),
        });
        const outcome = applyFilters(context, { from: 'A', to: 'B' });
        expect(outcome.verdict).toBe('rejected');
        expect(outcome.rejectedBy).toBe('temporal');
        expect(outcome.reason).toContain('zeitlich unmöglich');
    });

    it('verwirft NICHT bei fehlender Abdeckung — Unwissen ist kein Befund', () => {
        const context = contextOf({ coverage: new Map([['A', { from: '2026-05-01T00:00:00.000Z' }]]) });
        expect(applyFilters(context, { from: 'A', to: 'B' }).verdict).not.toBe('rejected');
    });

    it('verwirft zwei Größen ohne Pfad zwischen ihren Orten', () => {
        const context = contextOf({
            topology: new Map([
                ['A', { placeChain: ['keller'] }],
                ['B', { placeChain: ['dach'] }],
            ]),
            label: node => (node === 'keller' ? 'Keller' : node === 'dach' ? 'Dachboden' : node),
        });
        const outcome = applyFilters(context, { from: 'A', to: 'B' });
        expect(outcome.rejectedBy).toBe('topology');
        expect(outcome.reason).toContain('Keller');
        expect(outcome.reason).toContain('Dachboden');
    });

    it('lässt einen gemeinsamen Oberort und eine globale Größe durch', () => {
        const shared = contextOf({
            topology: new Map([
                ['A', { placeChain: ['bad', 'og'] }],
                ['B', { placeChain: ['flur', 'og'] }],
            ]),
        });
        expect(applyFilters(shared, { from: 'A', to: 'B' }).verdict).not.toBe('rejected');

        const global = contextOf({
            topology: new Map([
                ['Wetter', { global: true }],
                ['B', { placeChain: ['keller'] }],
            ]),
        });
        expect(applyFilters(global, { from: 'Wetter', to: 'B' }).verdict).not.toBe('rejected');
    });

    it('sagt bei fehlender Störgröße konstruktiv, WELCHE fehlt — und verwirft nicht', () => {
        // U wirkt auf beide, wird aber nicht erfasst: strukturell sauber,
        // aus den Daten nicht bestimmbar (Invariante C1 — die Datenlage
        // entscheidet nicht über die Annahme).
        const context = contextOf({
            edges: [['U', 'X'], ['U', 'Y']],
            observable: new Set(['X', 'Y']),
        });
        const outcome = applyFilters(context, { from: 'X', to: 'Y' });
        expect(outcome.verdict).toBe('open');
        expect(outcome.missingVariables).toEqual(['U']);
        expect(mayAdopt(outcome.verdict)).toBe(true);
    });

    it('nimmt einen sauber identifizierbaren Vorschlag an', () => {
        const context = contextOf({ edges: [['X', 'Z']], observable: new Set(['X', 'Z', 'Y']) });
        expect(applyFilters(context, { from: 'X', to: 'Y' }).verdict).toBe('accepted');
    });

    it('liest Zeitversätze inklusive Vorzeichen', () => {
        expect(lagSeconds('PT15M')).toBe(900);
        expect(lagSeconds('-PT15M')).toBe(-900);
        expect(lagSeconds('P1DT2H')).toBe(93_600);
        expect(lagSeconds('viertelstunde')).toBeNull();
    });
});

describe('Abnahme: die Filter laufen im Browser (§16 C1, C9)', () => {
    it('importiert nichts, was es nur auf dem Server gibt', () => {
        for (const file of ['filters.ts', 'propose.ts', 'compare.ts']) {
            const source = readFileSync(path.join(process.cwd(), 'src/lib/graph/causal', file), 'utf-8');
            const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map(match => match[1]);
            for (const specifier of imports) {
                expect(specifier.startsWith('./') || specifier.startsWith('../')).toBe(true);
                expect(specifier).not.toContain('node:');
                expect(specifier).not.toContain('store');
            }
            expect(source).not.toContain('process.');
            expect(source).not.toContain('fetch(');
        }
    });
});

// --- 2. Die drei Quellen, pur -------------------------------------------

describe('Die Quellen (§8)', () => {
    const variables = [
        { iri: variable('heizung'), name: 'Heizung', inModel: true, observed: true },
        { iri: variable('temperatur'), name: 'Temperatur', inModel: true, observed: true },
    ];

    it('nennt im Prompt Größen, Bestand und den Auftrag, Störgrößen zu finden', () => {
        const prompt = buildProposalPrompt('Wohnung', variables, [
            { from: variable('heizung'), to: variable('temperatur') },
        ]);
        expect(prompt).toContain(variable('heizung'));
        expect(prompt).toContain('STÖRGRÖSSEN');
        expect(prompt).toContain('Erfinde keine Größen');
        expect(prompt).toContain('"Heizung" → "Temperatur"');
    });

    it('liest JSON auch aus einem Code-Zaun und übernimmt Zeitversatz und Begründung', () => {
        const harvest = parseProposalResponse(
            '```json\n{"edges":[{"from":"' + variable('heizung') + '","to":"'
            + variable('temperatur') + '","lag":"PT30M","why":"Wärme braucht Zeit."}]}\n```',
            variables,
        );
        expect(harvest.problems).toEqual([]);
        expect(harvest.proposals).toEqual([{
            from: variable('heizung'),
            to: variable('temperatur'),
            temporalLag: 'PT30M',
            rationale: 'Wärme braucht Zeit.',
        }]);
    });

    it('quarantäniert eine erfundene Größe, ohne die brauchbaren mitzunehmen', () => {
        const harvest = parseProposalResponse(JSON.stringify({
            edges: [
                { from: variable('mond'), to: variable('temperatur'), why: 'Ausgedacht.' },
                { from: variable('heizung'), to: variable('temperatur'), why: 'Plausibel.' },
            ],
        }), variables);
        expect(harvest.proposals).toHaveLength(1);
        expect(harvest.proposals[0].from).toBe(variable('heizung'));
        expect(harvest.problems[0]).toContain('Größe, die es nicht gibt');
    });

    it('meldet eine Antwort ohne JSON, statt sie stillschweigend zu verschlucken', () => {
        const harvest = parseProposalResponse('Ich bin ein Sprachmodell und rede gern.', variables);
        expect(harvest.proposals).toEqual([]);
        expect(harvest.problems[0]).toContain('kein JSON-Objekt');
    });

    it('leitet aus der Registry Aktor → Sensor ab, aber nur bei gleichem Ort oder Gerät', () => {
        const harvest = proposeFromTopology([
            { variableIri: 'A', name: 'Heizung Bad', actuator: true, placeIri: 'bad', placeName: 'Bad' },
            { variableIri: 'B', name: 'Temperatur Bad', actuator: false, placeIri: 'bad', placeName: 'Bad' },
            { variableIri: 'C', name: 'Temperatur Keller', actuator: false, placeIri: 'keller' },
        ]);
        expect(harvest.proposals.map(proposal => `${proposal.from}->${proposal.to}`)).toEqual(['A->B']);
        expect(harvest.proposals[0].rationale).toContain('Bad');
    });

    it('baut eine Wikidata-Abfrage nur über die genannten Größenarten', () => {
        const query = buildWikidataQuery(['temperature', 'humidity']);
        expect(query).toContain('"temperature"@en');
        expect(query).toContain('wdt:P828');
        expect(query).toContain('wdt:P1542');
    });

    it('bildet Wikidata-Zeilen auf Modellvariablen zurück und erfindet nichts', () => {
        const byLabel = new Map([
            ['temperature', variables[1]],
            ['humidity', variables[0]],
        ]);
        const harvest = parseWikidataRows([
            { causeLabel: { value: 'temperature' }, effectLabel: { value: 'humidity' } },
            { causeLabel: { value: 'pressure' }, effectLabel: { value: 'humidity' } },
        ], byLabel);
        expect(harvest.proposals).toHaveLength(1);
        expect(harvest.proposals[0].from).toBe(variable('temperatur'));
        expect(harvest.proposals[0].rationale).toContain('keine Aussage über dieses Haus');
    });
});

// --- 3. Der Lauf über den Graphen ---------------------------------------

describe('Der Vorschlagslauf (§8) schreibt nach causal-hypotheses', () => {
    it('trägt Herkunft: Quelle, Sprachmodell und Prompt-Version (§8)', async () => {
        const fixture = await freshStore();
        const heizung = await seedVariable(fixture, { id: 'heizung', name: 'Heizung', kind: 'binary', actuator: true, place: 'Bad' });
        const temperatur = await seedVariable(fixture, { id: 'temperatur', name: 'Temperatur', place: 'Bad', observable: 'temperature' });
        await seedModel(fixture, [heizung, temperatur]);

        llm.answer = JSON.stringify({
            edges: [{ from: heizung, to: temperatur, lag: 'PT30M', why: 'Heizen erwärmt den Raum.' }],
        });
        const summary = await runProposalSources(fixture, MODEL, { sources: ['llm'] });
        expect(summary.sources[0].proposed).toBe(1);
        expect(summary.sources[0].accepted).toBe(1);

        const hypotheses = await readHypotheses(fixture);
        expect(hypotheses).toHaveLength(1);
        const [hypothesis] = hypotheses;
        expect(hypothesis.source).toBe('llm');
        expect(hypothesis.agentName).toBe('stub-modell-7b');
        expect(hypothesis.agentVersion).toBe(PROPOSAL_PROMPT_VERSION);
        expect(hypothesis.edgeClass).toBe('hypothesis');
        expect(hypothesis.temporalLag).toBe('PT30M');
        expect(hypothesis.verdict).toBe('accepted');
        expect(hypothesis.reason).toContain('Heizen erwärmt den Raum.');
        expect(hypothesis.inModel).toBe(false);

        // Invariante C2: Der Vorschlag steht NICHT im Modell-Graphen.
        const model = await readCausalModel(fixture, { modelId: MODEL, graph: iri.causalGraph(MODEL) });
        expect(model?.edges).toEqual([]);
    });

    it('verwirft einen temporal unmöglichen Vorschlag automatisch (Abnahme §16 C6)', async () => {
        const fixture = await freshStore();
        // Die Heizung wird erst ab Mai erfasst, der Temperatursturz nur bis
        // Februar. Keine erfasste Ursache geht hier einer erfassten Wirkung
        // voraus — das ist allein aus Zeitstempeln entscheidbar.
        const heizung = await seedVariable(fixture, {
            id: 'heizung', name: 'Heizung', kind: 'binary', actuator: true, place: 'Bad',
            from: '2026-05-01T00:00:00.000Z', through: '2026-08-01T00:00:00.000Z',
        });
        const sturz = await seedVariable(fixture, {
            id: 'sturz', name: 'Temperatursturz', place: 'Bad',
            from: '2026-01-01T00:00:00.000Z', through: '2026-02-01T00:00:00.000Z',
        });
        await seedModel(fixture, [heizung, sturz]);

        llm.answer = JSON.stringify({
            edges: [{ from: heizung, to: sturz, why: 'Klingt plausibel.' }],
        });
        const summary = await runProposalSources(fixture, MODEL, { sources: ['llm'] });
        expect(summary.sources[0].rejected).toBe(1);
        expect(summary.sources[0].accepted).toBe(0);

        const [hypothesis] = await readHypotheses(fixture);
        expect(hypothesis.verdict).toBe('rejected');
        expect(hypothesis.rejectedBy).toBe('temporal');
        expect(hypothesis.reason).toContain('zeitlich unmöglich');
        // Kein Mensch hat etwas getan: Der Lauf selbst hat entschieden.
        expect(hypothesis.inModel).toBe(false);
    });

    it('verwirft einen Vorschlag, der die gesetzte Richtung umdreht', async () => {
        const fixture = await freshStore();
        const heizung = await seedVariable(fixture, { id: 'heizung', name: 'Heizung', kind: 'binary', actuator: true, place: 'Bad' });
        const temperatur = await seedVariable(fixture, { id: 'temperatur', name: 'Temperatur', place: 'Bad' });
        await seedModel(fixture, [heizung, temperatur]);
        await applyStructureOperation(fixture, MODEL, {
            op: 'add-edge', from: heizung, to: temperatur, edgeClass: 'asserted',
        });

        llm.answer = JSON.stringify({ edges: [{ from: temperatur, to: heizung, why: 'Umgekehrt.' }] });
        await runProposalSources(fixture, MODEL, { sources: ['llm'] });
        const [hypothesis] = await readHypotheses(fixture);
        expect(hypothesis.rejectedBy).toBe('cycle');
        expect(hypothesis.reason).toContain('Kreis');
    });

    it('legt eine Quelle still, ohne die anderen mitzunehmen (Fehlerisolation wie C5)', async () => {
        const fixture = await freshStore();
        const heizung = await seedVariable(fixture, { id: 'heizung', name: 'Heizung', kind: 'binary', actuator: true, place: 'Bad', device: 'Thermostat' });
        const temperatur = await seedVariable(fixture, { id: 'temperatur', name: 'Temperatur', place: 'Bad', device: 'Thermostat' });
        await seedModel(fixture, [heizung, temperatur]);

        llm.error = 'Endpunkt nicht erreichbar';
        const summary = await runProposalSources(fixture, MODEL, { sources: ['llm', 'topology'] });
        const byId = new Map(summary.sources.map(entry => [entry.source, entry]));
        expect(byId.get('llm')?.unavailable).toContain('nicht geantwortet');
        expect(byId.get('topology')?.proposed).toBe(1);
        expect((await readHypotheses(fixture))[0].edgeClass).toBe('structural');
    });

    it('sagt ehrlich, dass es kein Sprachmodell gibt, statt zu schweigen', async () => {
        const fixture = await freshStore();
        const heizung = await seedVariable(fixture, { id: 'heizung', name: 'Heizung', kind: 'binary', actuator: true });
        await seedModel(fixture, [heizung]);
        const summary = await runProposalSources(fixture, MODEL, { sources: ['llm'] });
        expect(summary.sources[0].unavailable).toContain('Kein Sprachmodell konfiguriert');
        expect(summary.sources[0].proposed).toBe(0);
    });

    it('ersetzt nur die eigene Quelle, nicht die der anderen', async () => {
        const fixture = await freshStore();
        const heizung = await seedVariable(fixture, { id: 'heizung', name: 'Heizung', kind: 'binary', actuator: true, place: 'Bad' });
        const temperatur = await seedVariable(fixture, { id: 'temperatur', name: 'Temperatur', place: 'Bad' });
        await seedModel(fixture, [heizung, temperatur]);

        llm.answer = JSON.stringify({ edges: [{ from: heizung, to: temperatur, why: 'Vom Modell.' }] });
        await runProposalSources(fixture, MODEL, { sources: ['llm', 'topology'] });
        expect(await readHypotheses(fixture)).toHaveLength(2);

        // Ein zweiter Lauf NUR des Sprachmodells, das diesmal nichts sagt.
        llm.answer = JSON.stringify({ edges: [] });
        await runProposalSources(fixture, MODEL, { sources: ['llm'] });
        const remaining = await readHypotheses(fixture);
        expect(remaining).toHaveLength(1);
        expect(remaining[0].source).toBe('topology');
    });

    it('holt Störgrößen-Kandidaten aus Wikidata — ohne Import, über die Föderation', async () => {
        const fixture = await freshStore();
        const temperatur = await seedVariable(fixture, {
            id: 'temperatur', name: 'Temperatur', place: 'Bad', observable: 'temperature',
        });
        const feuchte = await seedVariable(fixture, {
            id: 'feuchte', name: 'Luftfeuchte', place: 'Bad', observable: 'humidity',
        });
        await seedModel(fixture, [temperatur, feuchte]);
        await createFederatedEndpoint(fixture, {
            id: 'wikidata',
            name: 'Wikidata',
            url: 'https://query.wikidata.org/sparql',
            trustLevel: 'known',
        });

        const summary = await runProposalSources(fixture, MODEL, {
            sources: ['wikidata'],
            wikidata: {
                fetchImpl: stubFetch(jsonResults([
                    { causeLabel: 'temperature', effectLabel: 'humidity' },
                ])),
            },
        });
        expect(summary.sources[0].proposed).toBe(1);
        const [hypothesis] = await readHypotheses(fixture);
        expect(hypothesis.source).toBe('wikidata');
        expect(hypothesis.from).toBe(temperatur);
        expect(hypothesis.to).toBe(feuchte);
        // Fremdes Weltwissen bleibt Hörensagen (Invariante C2).
        expect(hypothesis.edgeClass).toBe('hypothesis');
    });

    it('sagt ohne registrierten Endpoint, dass Wikidata nicht befragt wurde', async () => {
        const fixture = await freshStore();
        const temperatur = await seedVariable(fixture, { id: 'temperatur', name: 'Temperatur', observable: 'temperature' });
        await seedModel(fixture, [temperatur]);
        const summary = await runProposalSources(fixture, MODEL, { sources: ['wikidata'] });
        expect(summary.sources[0].unavailable).toContain('Kein Wikidata-Endpoint registriert');
    });
});

// --- 4. Die Abnahme: kein ungefilterter Weg in den Studien-Pfad ----------

describe('Abnahme §16 C6: keine Hypothese erreicht ohne Filter den Studien-Pfad', () => {
    async function withRejected(): Promise<{ fixture: Fixture; id: string }> {
        const fixture = await freshStore();
        const heizung = await seedVariable(fixture, { id: 'heizung', name: 'Heizung', kind: 'binary', actuator: true, place: 'Bad' });
        const temperatur = await seedVariable(fixture, { id: 'temperatur', name: 'Temperatur', place: 'Bad' });
        await seedModel(fixture, [heizung, temperatur]);
        await applyStructureOperation(fixture, MODEL, {
            op: 'add-edge', from: heizung, to: temperatur, edgeClass: 'asserted',
        });
        llm.answer = JSON.stringify({ edges: [{ from: temperatur, to: heizung, why: 'Umgekehrt.' }] });
        await runProposalSources(fixture, MODEL, { sources: ['llm'] });
        const [hypothesis] = await readHypotheses(fixture);
        expect(hypothesis.verdict).toBe('rejected');
        return { fixture, id: hypothesis.id };
    }

    it('lehnt das Übernehmen eines verworfenen Vorschlags ab — serverseitig', async () => {
        const { fixture, id } = await withRejected();
        await expect(adoptHypothesis(fixture, id)).rejects.toThrow(CausalEditError);
        await expect(adoptHypothesis(fixture, id)).rejects.toThrow(/verworfen/);
        const model = await readCausalModel(fixture, { modelId: MODEL, graph: iri.causalGraph(MODEL) });
        expect(model?.edges).toHaveLength(1);
        expect(model?.edges[0].edgeClass).toBe('asserted');
    });

    it('übernimmt einen zulässigen Vorschlag samt Herkunftsklasse und Zeitversatz', async () => {
        const fixture = await freshStore();
        const heizung = await seedVariable(fixture, { id: 'heizung', name: 'Heizung', kind: 'binary', actuator: true, place: 'Bad' });
        const temperatur = await seedVariable(fixture, { id: 'temperatur', name: 'Temperatur', place: 'Bad' });
        await seedModel(fixture, [heizung, temperatur]);
        llm.answer = JSON.stringify({
            edges: [{ from: heizung, to: temperatur, lag: 'PT30M', why: 'Heizen erwärmt.' }],
        });
        await runProposalSources(fixture, MODEL, { sources: ['llm'] });
        const [hypothesis] = await readHypotheses(fixture);

        const result = await adoptHypothesis(fixture, hypothesis.id);
        expect(result.message).toContain('übernommen');
        const model = await readCausalModel(fixture, { modelId: MODEL, graph: iri.causalGraph(MODEL) });
        expect(model?.edges).toHaveLength(1);
        expect(model?.edges[0].edgeClass).toBe('hypothesis');
        expect(model?.edges[0].evidenceLevel).toBe('hypothesis');
        expect(model?.edges[0].temporalLag).toBe('PT30M');
        // Jede Änderung eine Revision (Vorleistung für C7).
        expect(model?.revision).toBeGreaterThan(1);

        // Der Vorschlag bleibt stehen — sonst ginge die Herkunft verloren.
        const after = await readHypotheses(fixture);
        expect(after[0].inModel).toBe(true);
        await expect(adoptHypothesis(fixture, hypothesis.id)).rejects.toThrow(/bereits im Modell/);
    });

    it('nimmt eine noch nicht modellierte Störgröße beim Übernehmen mit auf', async () => {
        const fixture = await freshStore();
        const heizung = await seedVariable(fixture, { id: 'heizung', name: 'Heizung', kind: 'binary', actuator: true, place: 'Bad' });
        const temperatur = await seedVariable(fixture, { id: 'temperatur', name: 'Temperatur', place: 'Bad' });
        const aussen = await seedVariable(fixture, {
            id: 'aussentemperatur', name: 'Außentemperatur', sourceKind: 'rest-timeseries',
        });
        // Nur zwei Größen im Modell — die Außentemperatur schlägt das
        // Sprachmodell als Störgröße vor (§8: der wertvollere Teil).
        await seedModel(fixture, [heizung, temperatur]);
        llm.answer = JSON.stringify({ edges: [{ from: aussen, to: temperatur, why: 'Störgröße.' }] });
        await runProposalSources(fixture, MODEL, { sources: ['llm'] });
        const [hypothesis] = await readHypotheses(fixture);

        await adoptHypothesis(fixture, hypothesis.id);
        const model = await readCausalModel(fixture, { modelId: MODEL, graph: iri.causalGraph(MODEL) });
        expect(model?.variables.find(entry => entry.iri === aussen)?.inModel).toBe(true);
        expect(model?.edges.map(edge => `${edge.from}->${edge.to}`)).toEqual([`${aussen}->${temperatur}`]);
    });

    it('verwirft einen Vorschlag aus der Liste, ohne die Kante der anderen Quelle mitzunehmen', async () => {
        const fixture = await freshStore();
        const heizung = await seedVariable(fixture, { id: 'heizung', name: 'Heizung', kind: 'binary', actuator: true, place: 'Bad' });
        const temperatur = await seedVariable(fixture, { id: 'temperatur', name: 'Temperatur', place: 'Bad' });
        await seedModel(fixture, [heizung, temperatur]);
        llm.answer = JSON.stringify({ edges: [{ from: heizung, to: temperatur, why: 'Auch das Modell.' }] });
        await runProposalSources(fixture, MODEL, { sources: ['llm', 'topology'] });

        const llmHypothesis = (await readHypotheses(fixture)).find(entry => entry.source === 'llm');
        expect(llmHypothesis).toBeDefined();
        expect(await discardHypothesis(fixture, llmHypothesis!.id)).toBe(true);
        const remaining = await readHypotheses(fixture);
        expect(remaining.map(entry => entry.source)).toEqual(['topology']);

        // Das Kanten-Triple bleibt, weil die andere Quelle es noch trägt.
        const quads: Quad[] = [];
        for await (const quad of fixture.store.dump(namedNode(hypothesesGraph(iri)))) quads.push(quad);
        expect(quads.some(quad => quad.predicate.value === RO.causallyUpstreamOf)).toBe(true);

        // Zieht auch die letzte Quelle zurück, verschwindet es — eine
        // herkunftslose Behauptung wäre ein Verstoß gegen C2.
        await discardHypothesis(fixture, remaining[0].id);
        const empty: Quad[] = [];
        for await (const quad of fixture.store.dump(namedNode(hypothesesGraph(iri)))) empty.push(quad);
        expect(empty.some(quad => quad.predicate.value === RO.causallyUpstreamOf)).toBe(false);
    });
});

// --- 5. Der Quellenvergleich (§8 Rückkopplung) --------------------------

describe('Quellenvergleich (§8)', () => {
    it('erkennt Übereinstimmung zweier Quellen auf derselben Kante', async () => {
        const fixture = await freshStore();
        const heizung = await seedVariable(fixture, { id: 'heizung', name: 'Heizung', kind: 'binary', actuator: true, place: 'Bad' });
        const temperatur = await seedVariable(fixture, { id: 'temperatur', name: 'Temperatur', place: 'Bad' });
        await seedModel(fixture, [heizung, temperatur]);
        llm.answer = JSON.stringify({ edges: [{ from: heizung, to: temperatur, why: 'Auch das Modell.' }] });
        await runProposalSources(fixture, MODEL, { sources: ['llm', 'topology'] });

        const hypotheses = await readHypotheses(fixture);
        const comparison = compareStructureSources(hypotheses, [], node => node);
        expect(comparison).toHaveLength(1);
        expect(comparison[0].agreement).toBe('agreed');
        expect(comparison[0].claims.map(claim => claim.source).sort()).toEqual(['llm', 'topology']);
        // Die fehlende vierte Stimme wird benannt, nicht erfunden.
        expect(comparison[0].silentSources).toContain('asserted');
    });

    it('legt einen Widerspruch nach oben — er ist laut §8 der interessante Fall', async () => {
        const fixture = await freshStore();
        const heizung = await seedVariable(fixture, { id: 'heizung', name: 'Heizung', kind: 'binary', actuator: true, place: 'Bad' });
        const temperatur = await seedVariable(fixture, { id: 'temperatur', name: 'Temperatur', place: 'Bad' });
        const fenster = await seedVariable(fixture, { id: 'fenster', name: 'Fenster', kind: 'binary', actuator: true, place: 'Bad' });
        await seedModel(fixture, [heizung, temperatur, fenster]);
        await applyStructureOperation(fixture, MODEL, {
            op: 'add-edge', from: heizung, to: temperatur, edgeClass: 'asserted',
        });
        llm.answer = JSON.stringify({
            edges: [
                { from: temperatur, to: heizung, why: 'Das Thermostat regelt nach.' },
                { from: fenster, to: temperatur, why: 'Lüften kühlt.' },
            ],
        });
        await runProposalSources(fixture, MODEL, { sources: ['llm'] });

        const hypotheses = await readHypotheses(fixture);
        const model = await readCausalModel(fixture, { modelId: MODEL, graph: iri.causalGraph(MODEL) });
        const comparison = compareStructureSources(hypotheses, model!.edges, node => node);
        expect(comparison[0].agreement).toBe('contradiction');
        expect(comparison[0].summary).toContain('Beides zugleich kann nicht gelten');
        expect(comparison.map(entry => entry.agreement)).toEqual(['contradiction', 'single']);
    });

    it('zählt eine übernommene Kante als gesetzte Struktur, nicht doppelt', async () => {
        const fixture = await freshStore();
        const heizung = await seedVariable(fixture, { id: 'heizung', name: 'Heizung', kind: 'binary', actuator: true, place: 'Bad' });
        const temperatur = await seedVariable(fixture, { id: 'temperatur', name: 'Temperatur', place: 'Bad' });
        await seedModel(fixture, [heizung, temperatur]);
        await runProposalSources(fixture, MODEL, { sources: ['topology'] });
        const [hypothesis] = await readHypotheses(fixture);
        await adoptHypothesis(fixture, hypothesis.id);

        const model = await readCausalModel(fixture, { modelId: MODEL, graph: iri.causalGraph(MODEL) });
        const comparison = compareStructureSources(await readHypotheses(fixture), model!.edges, node => node);
        expect(comparison[0].claims.map(claim => claim.source)).toEqual(['asserted']);
        expect(comparison[0].agreement).toBe('single');
    });
});

// --- 6. Shapes und Persistenz -------------------------------------------

describe('Shapes und Persistenz', () => {
    const record: HypothesisRecord = {
        id: hypothesisId(MODEL, 'llm', variable('a'), variable('b')),
        modelId: MODEL,
        source: 'llm',
        from: variable('a'),
        to: variable('b'),
        edgeClass: 'hypothesis',
        verdict: 'accepted',
        reason: 'Weil.',
        generatedAt: '2026-08-14T10:00:00.000Z',
        agentName: 'stub-modell-7b',
        agentVersion: '1',
    };

    it('nimmt einen vollständigen Vorschlag an', async () => {
        const report = await validateQuads(shapes(), hypothesisQuads(iri, record));
        expect(report.results.filter(result => result.severity === 'Violation')).toEqual([]);
    });

    it('meldet einen Vorschlag ohne Urheber — Herkunft ist Pflicht (§8)', async () => {
        const quads = hypothesisQuads(iri, record)
            .filter(quad => quad.predicate.value !== PROV.wasAttributedTo);
        const report = await validateQuads(shapes(), quads);
        expect(report.results.some(result => result.message.includes('ohne Urheber'))).toBe(true);
    });

    it('meldet einen Urheber ohne Prompt-Version', async () => {
        const quads = hypothesisQuads(iri, record)
            .filter(quad => quad.predicate.value !== SCHEMA.softwareVersion);
        const report = await validateQuads(shapes(), quads);
        expect(report.results.some(result => result.message.includes('Prompt-'))).toBe(true);
    });

    it('meldet ein erfundenes Urteil und einen Filter ohne Ablehnung', async () => {
        const graph = namedNode(hypothesesGraph(iri));
        const reifier = namedNode(iri.entity('link', `hypothesis/${record.id}`));
        const invented = hypothesisQuads(iri, record).map(quad =>
            quad.predicate.value === OW.hypothesisVerdict
                ? factory.quad(quad.subject, quad.predicate, literal('vielleicht'), graph)
                : quad);
        expect((await validateQuads(shapes(), invented)).results
            .some(result => result.message.includes('genau ein Urteil'))).toBe(true);

        const mismatched = [
            ...hypothesisQuads(iri, record),
            factory.quad(reifier, namedNode(OW.filterRejectedBy), literal('temporal'), graph),
        ];
        expect((await validateQuads(shapes(), mismatched)).results
            .some(result => result.message.includes('nur an einem verworfenen Vorschlag'))).toBe(true);
    });

    it('liegt im Snapshot-Layout und überlebt damit den Neustart', async () => {
        expect(snapshotFileForGraph(hypothesesGraph(iri), INSTANCE_BASE)).toContain('causal-hypotheses.nq');

        const fixture = await freshStore();
        await createCausalModel(fixture, { id: MODEL, name: 'Wohnung' });
        await replaceHypotheses(fixture, MODEL, 'llm', [record]);
        const read = await readHypotheses(fixture);
        expect(read).toHaveLength(1);
        expect(read[0].id).toBe(record.id);

        // Dasselbe zweimal schreiben ergibt denselben Bestand — sonst wäre
        // der Snapshot nicht byte-gleich (Invariante 4).
        const before: Quad[] = [];
        for await (const quad of fixture.store.dump(namedNode(hypothesesGraph(iri)))) before.push(quad);
        await replaceHypotheses(fixture, MODEL, 'llm', [record]);
        const after: Quad[] = [];
        for await (const quad of fixture.store.dump(namedNode(hypothesesGraph(iri)))) after.push(quad);
        expect(after).toHaveLength(before.length);
    });

    it('gibt dem Agenten seine Kennung, damit der Vergleich nach ihr gruppieren kann', () => {
        const quads = hypothesisQuads(iri, record);
        const agent = quads.find(quad => quad.predicate.value === PROV.wasAttributedTo)?.object.value;
        expect(agent).toBeDefined();
        const identifier = quads.find(quad =>
            quad.subject.value === agent && quad.predicate.value === DCTERMS.identifier);
        expect(identifier?.object.value).toBe('llm');
    });
});
