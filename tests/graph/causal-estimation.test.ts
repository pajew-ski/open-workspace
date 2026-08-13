// @vitest-environment node
/**
 * Abnahme C4 — Schätzung und Refutation (CAUSAL_LAYER_SPEC §16, §19).
 *
 * Die Spec verlangt drei Nachweise, und sie stehen hier zuoberst:
 *
 *  1. **Ein bekannter Effekt aus synthetischen Daten wird korrekt
 *     geschätzt.** Die Wahrheit ist beim Erzeugen gesetzt; wenn der
 *     Schätzer sie nicht wiederfindet, ist er falsch.
 *  2. **Ein konfundierter Fall wird als solcher erkannt.** Zweimal: als
 *     Zahl (ohne Adjustierung ist die Schätzung nachweislich verzerrt,
 *     mit Adjustierung trifft sie) und als Auskunft (steht die Störgröße
 *     im Modell, wird aber nicht erfasst, heißt die Antwort „nicht
 *     identifizierbar" — mit ihrem Namen).
 *  3. **Ein durchgefallener Effekt erscheint NICHT als Effekt**
 *     (Invariante C5). Weder in der Rückgabe noch im Graphen; der
 *     durchgefallene Versuch dagegen schon.
 *
 * Dazu, was den Meilenstein sonst trägt: die Reproduktions-Signatur (C7),
 * die Scope-Partitionierung gegen den Inferenz-Leak (C6), der vollständige
 * Replace des Inferenz-Graphen (C4) und die Reinheit des Tier-1-Kerns
 * (C9 — dieselbe Rechnung läuft im Browser).
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Quad } from '@rdfjs/types';
import { OxigraphStore } from '@/lib/graph/store/oxigraph';
import { createIriFactory } from '@/lib/graph/iri';
import { namedNode } from '@/lib/graph/rdf';
import { OW, PROV, SCHEMA } from '@/lib/graph/vocab';
import { parseRdf } from '@/lib/graph/serialize/io';
import { validateQuads } from '@/lib/graph/reasoning/shacl';
import { createCausalModel, readCausalModel } from '@/lib/graph/causal/model';
import { applyStructureOperation } from '@/lib/graph/causal/edit';
import { createVariable, listVariables } from '@/lib/graph/observations/variables';
import type { Observation } from '@/lib/graph/observations/types';
import { buildPanel, checkPositivity } from '@/lib/graph/causal/panel';
import { estimateEffect } from '@/lib/graph/causal/estimate';
import { createRandom, normalDraw } from '@/lib/graph/causal/numeric';
import { runStudy, type StudySeries } from '@/lib/graph/causal/study';
import { createEstimand } from '@/lib/graph/causal/estimand';
import {
    causalInferredGraph,
    readCausalStudies,
    runCausalStudies,
    studyScope,
    type VariableMetadata,
} from '@/lib/graph/causal/study-graph';
import { dagFromModel } from '@/lib/graph/causal/view';

/**
 * Ein Studienlauf rechnet wirklich: Bootstrap und Refutationen gehen
 * mehrfach über dieselben Daten, die Negativkontrolle zieht ihr eigenes
 * Intervall. Auf einem geteilten CI-Läufer reichen die fünf Sekunden der
 * Voreinstellung dafür nicht. Die Rechnung so weit zu verkürzen, bis sie
 * hineinpasst, wäre die falsche Antwort — dann prüfte der Test nicht mehr
 * das, was im Betrieb läuft.
 */
vi.setConfig({ testTimeout: 60_000 });

const INSTANCE_BASE = 'https://ws.example.org/id/';
const iri = createIriFactory(INSTANCE_BASE);
const variableIri = (id: string) => iri.entity('variable', id);

const START = Date.parse('2026-06-01T00:00:00.000Z');
const STEP_SECONDS = 300;

function shapesQuads(): Quad[] {
    const dir = path.join(process.cwd(), 'ontology', 'shapes');
    return ['core.ttl', 'causal.ttl'].flatMap(name =>
        parseRdf(readFileSync(path.join(dir, name), 'utf-8'), { format: 'text/turtle' }));
}

async function dump(store: OxigraphStore, graphIri: string): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const quad of store.dump(namedNode(graphIri))) quads.push(quad);
    return quads;
}

function seriesOf(values: readonly (number | null)[]): Observation[] {
    return values.map((value, index) => ({
        t: START + index * STEP_SECONDS * 1000,
        v: value,
    }));
}

/**
 * Die Wahrheit, von Hand gesetzt: Eine Störgröße Z wirkt auf die
 * Behandlung T UND auf die Wirkung Y, und T wirkt mit der Stärke
 * `effect` auf Y. Wer nicht über Z adjustiert, misst zu viel — das ist
 * Konfundierung im Reinzustand.
 */
function confoundedWorld(rows: number, effect = 2, seed = 7) {
    const random = createRandom(seed);
    const z: number[] = [];
    const t: number[] = [];
    const y: number[] = [];
    for (let index = 0; index < rows; index += 1) {
        const zi = normalDraw(random);
        // P(T=1) steigt mit Z — genau der Weg, über den die Hintertür
        // offen steht.
        const ti = 1 / (1 + Math.exp(-1.5 * zi)) > random() ? 1 : 0;
        const yi = effect * ti + 3 * zi + 0.5 * normalDraw(random);
        z.push(zi);
        t.push(ti);
        y.push(yi);
    }
    return { z, t, y, effect };
}

function studySeries(key: string, values: readonly number[], kind: StudySeries['kind']): StudySeries {
    return {
        key,
        kind,
        intervalSeconds: STEP_SECONDS,
        observations: seriesOf(values),
        aggregation: kind === 'numeric' ? 'mean' : 'last',
        name: key,
    };
}

describe('Abnahme 1: bekannter Effekt aus synthetischen Daten (§16 C4)', () => {
    const world = confoundedWorld(720);
    const panel = buildPanel([
        studySeries('T', world.t, 'binary'),
        studySeries('Y', world.y, 'numeric'),
        studySeries('Z', world.z, 'numeric'),
    ]);

    it('baut ein lückenloses Panel über alle drei Größen', () => {
        expect(panel.rows).toBe(720);
        expect(panel.columns.map(column => column.key)).toEqual(['T', 'Y', 'Z']);
        expect(panel.problem).toBeUndefined();
        expect(checkPositivity(panel.column('T')).varies).toBe(true);
    });

    it('findet mit Adjustierung die gesetzte Wahrheit wieder (Regression)', () => {
        const outcome = estimateEffect(
            panel,
            { treatment: 'T', outcome: 'Y', adjustedFor: ['Z'], estimator: 'regression' },
            { seed: 42, samples: 80 },
        );
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.estimate.effect).toBeGreaterThan(world.effect - 0.25);
        expect(outcome.estimate.effect).toBeLessThan(world.effect + 0.25);
        // Ein Effekt ohne Intervall wird gar nicht erst ausgegeben — und
        // das Intervall ist echt: es umschließt die Schätzung und ist
        // schmal genug, um etwas auszusagen. Auf „das Intervall enthält
        // die Wahrheit" wird bewusst NICHT geprüft: Ein 95-%-Intervall
        // verfehlt sie in einem von zwanzig Fällen, und ein Test, der das
        // verbietet, prüfte den Seed statt den Schätzer.
        expect(outcome.estimate.ciLow).toBeLessThan(outcome.estimate.effect);
        expect(outcome.estimate.ciHigh).toBeGreaterThan(outcome.estimate.effect);
        expect(outcome.estimate.ciHigh - outcome.estimate.ciLow).toBeLessThan(0.5);
        expect(Math.abs(outcome.estimate.effect - world.effect))
            .toBeLessThan(3 * outcome.estimate.standardError);
        expect(outcome.estimate.bootstrapSamples).toBeGreaterThan(0);
    });

    it('findet sie auch über IPW und Stratifikation — zwei Wege, eine Zahl', () => {
        for (const estimator of ['ipw', 'stratification'] as const) {
            const outcome = estimateEffect(
                panel,
                { treatment: 'T', outcome: 'Y', adjustedFor: ['Z'], estimator },
                { seed: 42, samples: 80 },
            );
            expect(outcome.ok, `${estimator} liefert kein Ergebnis`).toBe(true);
            if (!outcome.ok) continue;
            expect(Math.abs(outcome.estimate.effect - world.effect), estimator).toBeLessThan(0.7);
        }
    });

    it('gibt dieselbe Zahl bei gleichem Seed — sonst wäre keine Studie reproduzierbar (C7)', () => {
        const spec = { treatment: 'T', outcome: 'Y', adjustedFor: ['Z'], estimator: 'regression' as const };
        const first = estimateEffect(panel, spec, { seed: 11, samples: 60 });
        const second = estimateEffect(panel, spec, { seed: 11, samples: 60 });
        expect(first).toEqual(second);
    });
});

describe('Abnahme 2: ein konfundierter Fall wird als solcher erkannt (§16 C4)', () => {
    const world = confoundedWorld(720);
    const panel = buildPanel([
        studySeries('T', world.t, 'binary'),
        studySeries('Y', world.y, 'numeric'),
        studySeries('Z', world.z, 'numeric'),
    ]);

    it('misst ohne Adjustierung nachweislich daneben', () => {
        const naive = estimateEffect(
            panel,
            { treatment: 'T', outcome: 'Y', adjustedFor: [], estimator: 'regression' },
            { seed: 42, samples: 60 },
        );
        const adjusted = estimateEffect(
            panel,
            { treatment: 'T', outcome: 'Y', adjustedFor: ['Z'], estimator: 'regression' },
            { seed: 42, samples: 60 },
        );
        expect(naive.ok && adjusted.ok).toBe(true);
        if (!naive.ok || !adjusted.ok) return;
        // Die Verzerrung geht in die Richtung, die die Struktur vorgibt:
        // Z hebt beides, also ist der naive Wert zu groß.
        expect(naive.estimate.effect).toBeGreaterThan(world.effect + 0.5);
        expect(Math.abs(adjusted.estimate.effect - world.effect)).toBeLessThan(0.25);
        // Und das Intervall der naiven Schätzung enthält die Wahrheit nicht.
        expect(naive.estimate.ciLow).toBeGreaterThan(world.effect);
    });

    it('sagt „nicht identifizierbar" und nennt die Störgröße, wenn sie nicht erfasst ist', async () => {
        const store = new OxigraphStore();
        const handle = { store, iri };
        await createCausalModel(handle, { id: 'wohnung', name: 'Wohnung' });
        // Z steht im Modell, wird aber nicht erfasst (keine ow:Variable in
        // graph/meta) — genau der Fall, für den C1 gebaut wurde.
        await seedVariables(handle, ['t', 'y']);
        for (const [id, name] of [['t', 'Heizen'], ['y', 'Verbrauch'], ['z', 'Außentemperatur']] as const) {
            await applyStructureOperation(handle, 'wohnung', {
                op: 'add-variable',
                iri: variableIri(id),
                name,
            });
        }
        for (const [from, to] of [['z', 't'], ['z', 'y'], ['t', 'y']] as const) {
            await applyStructureOperation(handle, 'wohnung', {
                op: 'add-edge',
                from: variableIri(from),
                to: variableIri(to),
                edgeClass: 'asserted',
            });
        }
        const model = await readCausalModel(handle, { modelId: 'wohnung', graph: iri.causalGraph('wohnung') });
        expect(model).not.toBeNull();
        if (!model) return;

        const result = runStudy({
            spec: {
                id: 'frage',
                treatment: variableIri('t'),
                outcome: variableIri('y'),
                estimator: 'auto',
                seed: 1,
            },
            model,
            series: [
                studySeries(variableIri('t'), world.t, 'binary'),
                studySeries(variableIri('y'), world.y, 'numeric'),
            ],
            bootstrapSamples: 40,
        });
        expect(result.verdict).toBe('not-identifiable');
        expect(result.reason).toContain('Außentemperatur');
        expect(result.effect).toBeUndefined();
        expect(result.identification.missingVariables).toEqual([variableIri('z')]);
    });
});

/** Legt Beobachtungsgrößen in graph/meta an — sonst gilt nichts als erfasst. */
async function seedVariables(
    handle: { store: OxigraphStore; iri: typeof iri },
    ids: readonly string[],
    kinds: Readonly<Record<string, 'numeric' | 'binary'>> = {},
): Promise<void> {
    for (const id of ids) {
        const kind = kinds[id] ?? 'numeric';
        await createVariable(handle, {
            id,
            name: id.toUpperCase(),
            sourceKind: 'test',
            source: `sensor.${id}`,
            kind,
            aggregation: kind === 'binary' ? 'last' : 'mean',
            intervalSeconds: STEP_SECONDS,
            ...(kind === 'numeric' ? { unit: 'kWh' } : {}),
        });
    }
}

interface WorldModel {
    store: OxigraphStore;
    handle: { store: OxigraphStore; iri: typeof iri };
    metadata: VariableMetadata[];
    series: Map<string, Observation[]>;
}

/**
 * Der Produktivpfad in klein: Modell im Store, Größen in graph/meta,
 * Reihen daneben — genau die Aufteilung aus Invariante C3.
 */
async function buildWorld(options: {
    variables: ReadonlyArray<{ id: string; kind: 'numeric' | 'binary'; values: readonly number[] }>;
    edges: ReadonlyArray<[string, string]>;
    modelId?: string;
}): Promise<WorldModel> {
    const store = new OxigraphStore();
    const handle = { store, iri };
    const modelId = options.modelId ?? 'wohnung';
    await store.load(shapesQuads(), namedNode(iri.sharedGraph('shapes')), { replace: true });
    await createCausalModel(handle, { id: modelId, name: 'Wohnung' });
    await seedVariables(
        handle,
        options.variables.map(entry => entry.id),
        Object.fromEntries(options.variables.map(entry => [entry.id, entry.kind])),
    );
    for (const entry of options.variables) {
        await applyStructureOperation(handle, modelId, {
            op: 'add-variable',
            iri: variableIri(entry.id),
            name: entry.id.toUpperCase(),
        });
    }
    for (const [from, to] of options.edges) {
        await applyStructureOperation(handle, modelId, {
            op: 'add-edge',
            from: variableIri(from),
            to: variableIri(to),
            edgeClass: 'asserted',
        });
    }
    const metadata: VariableMetadata[] = (await listVariables(handle)).map(view => ({
        iri: view.iri,
        id: view.id,
        name: view.name,
        kind: view.kind,
        aggregation: view.aggregation,
        intervalSeconds: view.intervalSeconds,
        ...(view.unit ? { unit: view.unit } : {}),
    }));
    const series = new Map<string, Observation[]>(
        options.variables.map(entry => [entry.id, seriesOf(entry.values)]),
    );
    return { store, handle, metadata, series };
}

/**
 * `bootstrapSamples` steht hier klein: Wo ein Test die Zahl selbst prüft,
 * braucht er ein belastbares Intervall; wo er nur prüft, WAS im Graphen
 * landet, genügt die Untergrenze, ab der ein Intervall überhaupt
 * entsteht.
 */
function runOptions(
    world: WorldModel,
    samples = 60,
    now = new Date('2026-08-13T10:00:00.000Z'),
) {
    return {
        now,
        softwareVersion: '0.1.0-test',
        bootstrapSamples: samples,
        readSeries: async (variableId: string) => world.series.get(variableId) ?? [],
    };
}

describe('Der Lauf schreibt die Studie in den Inferenz-Graphen (C4/C7)', () => {
    it('schätzt, refutiert und hinterlässt eine vollständige Signatur', async () => {
        const truth = confoundedWorld(720);
        const world = await buildWorld({
            variables: [
                { id: 't', kind: 'binary', values: truth.t },
                { id: 'y', kind: 'numeric', values: truth.y },
                { id: 'z', kind: 'numeric', values: truth.z },
            ],
            edges: [['z', 't'], ['z', 'y'], ['t', 'y']],
        });
        await createEstimand(world.handle, {
            id: 'heizen-auf-verbrauch',
            name: 'Wirkung des Heizens auf den Verbrauch',
            modelId: 'wohnung',
            treatment: variableIri('t'),
            outcome: variableIri('y'),
            estimator: 'regression',
            seed: 42,
        });

        const summary = await runCausalStudies(world.handle, world.metadata, runOptions(world));
        expect(summary.skipped).toEqual([]);
        expect(summary.rejected).toEqual([]);
        expect(summary.results).toHaveLength(1);
        const result = summary.results[0];
        expect(result.verdict).toBe('passed');
        expect(result.effect?.effect).toBeGreaterThan(1.7);
        expect(result.effect?.effect).toBeLessThan(2.3);
        expect(result.adjustedFor).toEqual([variableIri('z')]);

        const quads = await dump(world.store, causalInferredGraph(iri, 'workspace'));
        const values = (predicate: string) => quads
            .filter(quad => quad.predicate.value === predicate)
            .map(quad => quad.object.value);
        // Reproduktions-Signatur (C7): jedes Stück davon steht im Graphen.
        // Revision 7 = Anlage plus drei Variablen plus drei Kanten; genau
        // diese Zahl macht später nachvollziehbar, WELCHE Annahme galt.
        expect(values(OW.modelRevision)).toEqual(['7']);
        expect(values(OW.seed)).toEqual(['42']);
        expect(values(SCHEMA.softwareVersion)).toEqual(['0.1.0-test']);
        expect(values(OW.estimator)).toEqual(['regression']);
        expect(values(OW.identificationStrategy)).toEqual(['backdoor']);
        expect(values(OW.studyVerdict)).toEqual(['passed']);
        // Der Store normalisiert xsd:dateTime (Millisekunden fallen weg,
        // wenn sie null sind) — verglichen wird deshalb der Zeitpunkt.
        expect(Date.parse(values(PROV.generatedAtTime)[0]))
            .toBe(Date.parse('2026-08-13T10:00:00.000Z'));
        expect(values(SCHEMA.temporalCoverage)[0]).toContain('/');
        expect(Number(values(SCHEMA.numberOfItems)[0])).toBe(720);
        expect(values(OW.adjustedFor)).toEqual([variableIri('z')]);
        // Jede Eingabe ist mit ihrer eingefrorenen Erfassungsregel dabei.
        expect(values(OW.aggregation).sort()).toEqual(['last', 'mean', 'mean']);
        expect(values(OW.samplingInterval)).toEqual(['PT5M', 'PT5M', 'PT5M']);
        // Der Effekt hängt am Reifier der Kante — im Inferenz-Graphen.
        expect(values(OW.effectSize)).toHaveLength(1);
        expect(values(OW.refutationPassed)).toEqual(['true']);
        expect(values(OW.evidenceLevel)).toEqual(['refuted-clean']);

        // …und im Modell-Graphen steht davon NICHTS (Invariante C4).
        const modelQuads = await dump(world.store, iri.causalGraph('wohnung'));
        expect(modelQuads.some(quad => quad.predicate.value === OW.effectSize)).toBe(false);
        expect(modelQuads
            .filter(quad => quad.predicate.value === OW.evidenceLevel)
            .map(quad => quad.object.value)).toEqual(['hypothesis', 'hypothesis', 'hypothesis']);
    });

    it('hebt den Belegstand der Kante, ohne die Annahme anzufassen', async () => {
        const truth = confoundedWorld(720);
        const world = await buildWorld({
            variables: [
                { id: 't', kind: 'binary', values: truth.t },
                { id: 'y', kind: 'numeric', values: truth.y },
                { id: 'z', kind: 'numeric', values: truth.z },
            ],
            edges: [['z', 't'], ['z', 'y'], ['t', 'y']],
        });
        await createEstimand(world.handle, {
            id: 'heizen-auf-verbrauch',
            name: 'Wirkung des Heizens auf den Verbrauch',
            modelId: 'wohnung',
            treatment: variableIri('t'),
            outcome: variableIri('y'),
            estimator: 'regression',
            seed: 42,
        });
        await runCausalStudies(world.handle, world.metadata, runOptions(world));

        const model = await readCausalModel(world.handle, {
            modelId: 'wohnung',
            graph: iri.causalGraph('wohnung'),
        });
        const edge = model?.edges.find(candidate =>
            candidate.from === variableIri('t') && candidate.to === variableIri('y'));
        expect(edge?.evidenceLevel).toBe('hypothesis');
        expect(edge?.studyEvidence).toBe('refuted-clean');
        expect(edge?.effect?.value).toBeGreaterThan(1.7);
        // Und damit greift `minEvidence` aus C2 zum ersten Mal wirklich:
        // Genau diese eine Kante überlebt die schärfste Schwelle.
        const strict = dagFromModel(model!, { minEvidence: 'refuted-clean' });
        expect(strict.dag.edges).toEqual([{ from: variableIri('t'), to: variableIri('y') }]);
        expect(strict.droppedByEvidence).toHaveLength(2);
    });

    it('ersetzt bei jedem Lauf vollständig — eine gelöschte Frage lässt nichts zurück', async () => {
        const truth = confoundedWorld(400);
        const world = await buildWorld({
            variables: [
                { id: 't', kind: 'binary', values: truth.t },
                { id: 'y', kind: 'numeric', values: truth.y },
                { id: 'z', kind: 'numeric', values: truth.z },
            ],
            edges: [['z', 't'], ['z', 'y'], ['t', 'y']],
        });
        await createEstimand(world.handle, {
            id: 'erste-frage',
            name: 'Erste Frage',
            modelId: 'wohnung',
            treatment: variableIri('t'),
            outcome: variableIri('y'),
            estimator: 'regression',
            seed: 42,
        });
        await runCausalStudies(world.handle, world.metadata, runOptions(world, 40));
        expect(await readCausalStudies(world.handle)).toHaveLength(1);

        const { deleteEstimand } = await import('@/lib/graph/causal/estimand');
        await deleteEstimand(world.handle, 'erste-frage');
        await runCausalStudies(world.handle, world.metadata, runOptions(world, 40));
        expect(await readCausalStudies(world.handle)).toEqual([]);
    });
});

describe('Abnahme 3: ein durchgefallener Effekt erscheint nicht als Effekt (C5)', () => {
    /**
     * Das Modell behauptet, W hänge mit nichts zusammen. Die Daten sagen
     * das Gegenteil: W ist praktisch die Behandlung. Damit ist nicht die
     * Schätzung falsch, sondern die **Annahme** — und genau das ist die
     * schärfere Falsifikationsebene aus §13.2.
     */
    async function refutedWorld() {
        const truth = confoundedWorld(600, 2, 3);
        const w = truth.t.map((value, index) => value + 0.01 * ((index % 7) - 3));
        const world = await buildWorld({
            variables: [
                { id: 't', kind: 'binary', values: truth.t },
                { id: 'y', kind: 'numeric', values: truth.y },
                { id: 'z', kind: 'numeric', values: truth.z },
                { id: 'w', kind: 'numeric', values: w },
            ],
            edges: [['z', 't'], ['z', 'y'], ['t', 'y']],
        });
        await createEstimand(world.handle, {
            id: 'durchgefallen',
            name: 'Frage, die durchfällt',
            modelId: 'wohnung',
            treatment: variableIri('t'),
            outcome: variableIri('y'),
            estimator: 'regression',
            seed: 42,
        });
        return world;
    }

    it('gibt kein Ergebnis zurück, aber den durchgefallenen Versuch', async () => {
        const world = await refutedWorld();
        const summary = await runCausalStudies(world.handle, world.metadata, runOptions(world));
        const result = summary.results[0];
        expect(result.verdict).toBe('refuted');
        expect(result.effect).toBeUndefined();
        // Gerechnet wurde sehr wohl — die Zahl bleibt nur im Ergebnisobjekt
        // für die Erklärung und geht nie in den Graphen.
        expect(result.rawEstimate?.effect).toBeGreaterThan(0);
        const failures = result.refutations.filter(entry => entry.blocking && entry.verdict !== 'passed');
        expect(failures.length).toBeGreaterThan(0);
        expect(result.reason).toContain('Invariante C5');
    });

    it('schreibt keine einzige Effektstärke in den Graphen', async () => {
        const world = await refutedWorld();
        await runCausalStudies(world.handle, world.metadata, runOptions(world));
        const quads = await dump(world.store, causalInferredGraph(iri, 'workspace'));
        expect(quads.some(quad => quad.predicate.value === OW.effectSize)).toBe(false);
        expect(quads.some(quad => quad.predicate.value === OW.ciLow)).toBe(false);
        expect(quads.some(quad => quad.predicate.value === OW.refutationPassed)).toBe(false);
        // Der Versuch selbst ist da, mit Verdikt und Begründung.
        expect(quads.filter(quad => quad.predicate.value === OW.refutationMethod).length).toBeGreaterThan(0);
        expect(quads
            .filter(quad => quad.predicate.value === OW.refutationVerdict)
            .map(quad => quad.object.value)).toContain('failed');

        const studies = await readCausalStudies(world.handle);
        expect(studies[0].verdict).toBe('refuted');
        expect(studies[0].effect).toBeUndefined();
        expect(studies[0].refutations.some(entry => entry.verdict === 'failed')).toBe(true);
    });

    it('lehnt eine Effektstärke ohne bestandene Refutation schon in den Shapes ab (C5)', async () => {
        const reifier = namedNode(`${INSTANCE_BASE}u/default/link/causal/wohnung/t/y`);
        const graph = namedNode(iri.inferredGraph('causal/workspace'));
        const { factory, typedLiteral } = await import('@/lib/graph/rdf');
        const forged = [
            factory.quad(reifier, namedNode(OW.effectSize), typedLiteral.decimal(1.5), graph),
            factory.quad(reifier, namedNode(OW.ciLow), typedLiteral.decimal(1), graph),
            factory.quad(reifier, namedNode(OW.ciHigh), typedLiteral.decimal(2), graph),
            factory.quad(reifier, namedNode(PROV.wasGeneratedBy), namedNode(`${INSTANCE_BASE}u/default/study/x`), graph),
        ];
        const report = await validateQuads(shapesQuads(), forged);
        expect(report.conforms).toBe(false);
        expect(report.results.map(entry => entry.message).join(' ')).toContain('Invariante C5');
    });
});

describe('Kein Inferenz-Leak (Invariante C6) und keine Studie ohne Signatur (C7)', () => {
    it('lässt den öffentlichen Kausal-Inferenz-Graphen leer', async () => {
        const truth = confoundedWorld(400);
        const world = await buildWorld({
            variables: [
                { id: 't', kind: 'binary', values: truth.t },
                { id: 'y', kind: 'numeric', values: truth.y },
                { id: 'z', kind: 'numeric', values: truth.z },
            ],
            edges: [['z', 't'], ['z', 'y'], ['t', 'y']],
        });
        await createEstimand(world.handle, {
            id: 'privat',
            name: 'Frage über private Reihen',
            modelId: 'wohnung',
            treatment: variableIri('t'),
            outcome: variableIri('y'),
            estimator: 'regression',
            seed: 42,
        });
        const summary = await runCausalStudies(world.handle, world.metadata, runOptions(world, 40));
        expect(summary.scope).toBe('workspace');

        const publicQuads = await dump(world.store, causalInferredGraph(iri, 'public'));
        expect(publicQuads).toEqual([]);
        expect(await readCausalStudies(world.handle, 'public')).toEqual([]);
        // Die Regel selbst, nicht nur ihr Ergebnis: Nur was ausschließlich
        // aus dem öffentlichen Graphen stammt, käme dorthin.
        expect(studyScope(iri, [iri.graph('public')])).toBe('public');
        expect(studyScope(iri, [iri.graph('public'), iri.sharedGraph('meta')])).toBe('workspace');
        expect(studyScope(iri, [])).toBe('workspace');
    });

    it('zeigt einem verengten Zugang keinen Effekt an der Kante', async () => {
        const truth = confoundedWorld(400);
        const world = await buildWorld({
            variables: [
                { id: 't', kind: 'binary', values: truth.t },
                { id: 'y', kind: 'numeric', values: truth.y },
                { id: 'z', kind: 'numeric', values: truth.z },
            ],
            edges: [['z', 't'], ['z', 'y'], ['t', 'y']],
        });
        await createEstimand(world.handle, {
            id: 'privat',
            name: 'Frage über private Reihen',
            modelId: 'wohnung',
            treatment: variableIri('t'),
            outcome: variableIri('y'),
            estimator: 'regression',
            seed: 42,
        });
        await runCausalStudies(world.handle, world.metadata, runOptions(world, 40));

        const { listCausalModels } = await import('@/lib/graph/causal/model');
        const narrowed = await listCausalModels(world.handle, {
            allowedGraphs: [iri.causalGraph('wohnung')],
        });
        expect(narrowed).toHaveLength(1);
        expect(narrowed[0].edges.every(edge => edge.effect === undefined)).toBe(true);
        expect(narrowed[0].edges.every(edge => edge.studyEvidence === undefined)).toBe(true);
    });

    it('schreibt eine Studie ohne Softwareversion nicht, sondern meldet sie', async () => {
        const withoutVersion = [
            ...(await (async () => {
                const { factory, literal, typedLiteral } = await import('@/lib/graph/rdf');
                const graph = namedNode(iri.inferredGraph('causal/workspace'));
                const study = namedNode(`${INSTANCE_BASE}u/default/study/x`);
                const { RDF } = await import('@/lib/graph/vocab');
                return [
                    factory.quad(study, namedNode(RDF.type), namedNode(OW.CausalStudy), graph),
                    factory.quad(study, namedNode(OW.studyVerdict), literal('passed'), graph),
                    factory.quad(study, namedNode(OW.modelRevision), typedLiteral.integer(2), graph),
                    factory.quad(study, namedNode(OW.seed), typedLiteral.integer(1), graph),
                    factory.quad(study, namedNode(OW.treatment), namedNode(variableIri('t')), graph),
                    factory.quad(study, namedNode(OW.outcome), namedNode(variableIri('y')), graph),
                    factory.quad(
                        study,
                        namedNode(PROV.generatedAtTime),
                        typedLiteral.dateTime('2026-08-13T10:00:00.000Z'),
                        graph,
                    ),
                ];
            })()),
        ];
        const report = await validateQuads(shapesQuads(), withoutVersion);
        expect(report.conforms).toBe(false);
        expect(report.results.map(entry => entry.message).join(' ')).toContain('Softwareversion');
    });
});

describe('Das Panel: aus Reihen wird eine Tabelle (§6)', () => {
    it('nimmt das gröbste Raster — verfeinern hieße Werte erfinden', () => {
        const panel = buildPanel([
            { key: 'fein', kind: 'numeric', intervalSeconds: 300, observations: seriesOf([1, 2, 3, 4]) },
            {
                key: 'grob',
                kind: 'numeric',
                intervalSeconds: 600,
                observations: [0, 1].map(index => ({ t: START + index * 600_000, v: index })),
            },
        ]);
        expect(panel.intervalSeconds).toBe(600);
    });

    it('wendet den Zeitversatz an: die Ursache wird früher gelesen', () => {
        const panel = buildPanel([
            {
                key: 'ursache',
                kind: 'numeric',
                intervalSeconds: STEP_SECONDS,
                observations: seriesOf([10, 20, 30, 40]),
                lagSeconds: 2 * STEP_SECONDS,
            },
            { key: 'wirkung', kind: 'numeric', intervalSeconds: STEP_SECONDS, observations: seriesOf([1, 2, 3, 4]) },
        ]);
        // Erst ab dem dritten Rasterpunkt gibt es eine um zwei Schritte
        // zurückliegende Ursache — davor endet das gemeinsame Fenster.
        expect(panel.rows).toBe(2);
        expect(panel.column('ursache')?.values).toEqual([10, 20]);
        expect(panel.column('wirkung')?.values).toEqual([3, 4]);
    });

    it('streicht eine Zeile mit Lücke und sagt, an welcher Größe es lag', () => {
        const panel = buildPanel([
            { key: 'a', kind: 'numeric', intervalSeconds: STEP_SECONDS, observations: seriesOf([1, null, 3, 4]) },
            { key: 'b', kind: 'numeric', intervalSeconds: STEP_SECONDS, observations: seriesOf([5, 6, 7, 8]) },
        ]);
        expect(panel.rows).toBe(3);
        expect(panel.column('a')?.droppedRows).toBe(1);
        expect(panel.column('b')?.droppedRows).toBe(0);
        expect(panel.column('b')?.values).toEqual([5, 7, 8]);
    });

    it('meldet fehlende Positivität, statt eine Zahl zu erfinden (§15.3)', () => {
        const constant = buildPanel([
            { key: 't', kind: 'binary', intervalSeconds: STEP_SECONDS, observations: seriesOf([1, 1, 1, 1]) },
        ]);
        const report = checkPositivity(constant.column('t'));
        expect(report.varies).toBe(false);
        expect(report.reason).toContain('konstant');
    });
});

describe('Zeitliche Verfahren: DiD und ITS (§7 Tier 1)', () => {
    const rows = 400;
    const cut = 200;
    const interventionAt = START + cut * STEP_SECONDS * 1000;

    it('findet den Niveausprung einer unterbrochenen Zeitreihe', () => {
        const random = createRandom(5);
        const y = Array.from({ length: rows }, (_, index) =>
            10 + 0.01 * index + (index >= cut ? 5 : 0) + 0.3 * normalDraw(random));
        const panel = buildPanel([
            studySeries('T', Array.from({ length: rows }, (_, index) => (index >= cut ? 1 : 0)), 'binary'),
            studySeries('Y', y, 'numeric'),
        ]);
        const outcome = estimateEffect(
            panel,
            { treatment: 'T', outcome: 'Y', adjustedFor: [], estimator: 'its', interventionAt },
            { seed: 3, samples: 60 },
        );
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(Math.abs(outcome.estimate.effect - 5)).toBeLessThan(0.4);
    });

    it('rechnet bei DiD den gemeinsamen Trend heraus', () => {
        const random = createRandom(9);
        const trend = Array.from({ length: rows }, (_, index) => 0.02 * index);
        const control = trend.map(value => value + 0.3 * normalDraw(random));
        const treated = trend.map((value, index) => value + (index >= cut ? 4 : 0) + 0.3 * normalDraw(random));
        const panel = buildPanel([
            studySeries('T', Array.from({ length: rows }, (_, index) => (index >= cut ? 1 : 0)), 'binary'),
            studySeries('Y', treated, 'numeric'),
            studySeries('C', control, 'numeric'),
        ]);
        const outcome = estimateEffect(
            panel,
            {
                treatment: 'T',
                outcome: 'Y',
                adjustedFor: [],
                estimator: 'did',
                controlOutcome: 'C',
                interventionAt,
            },
            { seed: 3, samples: 60 },
        );
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(Math.abs(outcome.estimate.effect - 4)).toBeLessThan(0.3);
    });

    it('verweigert DiD ohne Kontroll-Wirkung, statt still etwas anderes zu rechnen', () => {
        const panel = buildPanel([
            studySeries('T', Array.from({ length: 40 }, (_, index) => (index >= 20 ? 1 : 0)), 'binary'),
            studySeries('Y', Array.from({ length: 40 }, (_, index) => index), 'numeric'),
        ]);
        const outcome = estimateEffect(
            panel,
            { treatment: 'T', outcome: 'Y', adjustedFor: [], estimator: 'did', interventionAt },
            { seed: 3, samples: 40 },
        );
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.problem).toContain('Kontroll-Wirkung');
    });
});

describe('Die Frage als Graph-Bürger (ow:Estimand)', () => {
    async function handleWithModel() {
        const world = await buildWorld({
            variables: [
                { id: 't', kind: 'binary', values: [0, 1, 0, 1] },
                { id: 'y', kind: 'numeric', values: [1, 2, 3, 4] },
            ],
            edges: [['t', 'y']],
        });
        return world.handle;
    }

    it('legt eine Frage in graph/meta an und liest sie zurück', async () => {
        const handle = await handleWithModel();
        const created = await createEstimand(handle, {
            id: 'frage-1',
            name: 'Erste Frage',
            modelId: 'wohnung',
            treatment: variableIri('t'),
            outcome: variableIri('y'),
            estimator: 'auto',
            seed: 42,
        });
        expect(created.iri).toBe(iri.entity('estimand', 'frage-1'));
        const { listEstimands } = await import('@/lib/graph/causal/estimand');
        const all = await listEstimands(handle);
        expect(all).toHaveLength(1);
        expect(all[0].modelId).toBe('wohnung');
        expect(all[0].seed).toBe(42);
        // Sie liegt in graph/meta — nicht im Inferenz-Graphen, der bei
        // jedem Lauf ersetzt wird.
        const meta = await dump(handle.store, iri.sharedGraph('meta'));
        expect(meta.some(quad => quad.object.value === OW.Estimand)).toBe(true);
    });

    it('lehnt ab, was später keine Signatur ergäbe', async () => {
        const handle = await handleWithModel();
        const base = {
            id: 'frage-2',
            name: 'Zweite Frage',
            modelId: 'wohnung',
            treatment: variableIri('t'),
            outcome: variableIri('y'),
            estimator: 'auto' as const,
            seed: 42,
        };
        await expect(createEstimand(handle, { ...base, outcome: base.treatment }))
            .rejects.toThrow('dieselbe Größe');
        await expect(createEstimand(handle, { ...base, seed: 1.5 }))
            .rejects.toThrow('ganze Zahl');
        await expect(createEstimand(handle, { ...base, interventionAt: 'gestern' }))
            .rejects.toThrow('Zeitpunkt');
        await expect(createEstimand(handle, {
            ...base,
            windowFrom: '2026-08-01T00:00:00Z',
            windowThrough: '2026-07-01T00:00:00Z',
        })).rejects.toThrow('endet, bevor es beginnt');
    });
});

describe('Der Schätzkern läuft im Browser (Invariante C9)', () => {
    const TIER1 = ['numeric.ts', 'panel.ts', 'estimate.ts', 'refute.ts', 'study.ts'];

    it('importiert nichts, was es nur auf dem Server gibt', () => {
        for (const file of TIER1) {
            const source = readFileSync(path.join(process.cwd(), 'src/lib/graph/causal', file), 'utf-8');
            const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map(match => match[1]);
            for (const specifier of imports) {
                expect(specifier.startsWith('./') || specifier.startsWith('../'), `${file}: ${specifier}`).toBe(true);
                expect(specifier, file).not.toContain('node:');
                expect(specifier, file).not.toContain('/store');
            }
            expect(source, file).not.toContain('process.');
            expect(source, file).not.toContain('fetch(');
            // Kein Zufall aus der Umgebung — sonst wäre keine Studie
            // reproduzierbar (Invariante C7).
            expect(source, file).not.toContain('Math.random');
        }
    });
});
