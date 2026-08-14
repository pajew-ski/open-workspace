// @vitest-environment node
/**
 * Die Studien-Chronik (docs/spec-widersprueche.md, Eintrag 3 —
 * entschieden am 2026-08-14).
 *
 * **Das gelöste Problem**: Invariante C4 ersetzt den Inferenz-Graphen bei
 * jedem Lauf, §8.1 persistiert ihn nie. Zusammen hieß das: keine
 * Historie. „Was sagte dieselbe Frage vor drei Monaten?" war nicht
 * beantwortbar, und ein geändertes Modell nahm seine alten Antworten mit
 * ins Nichts.
 *
 * Geprüft wird deshalb genau das, was die Chronik von einer zweiten Kopie
 * des Inferenz-Graphen unterscheidet:
 *
 *  1. **Sie hält fest, was war** — und überlebt den Neustart, weil ein
 *     Ereignis sich nicht neu berechnen lässt.
 *  2. **Sie wächst nur bei Änderung.** Zwanzig identische Läufe sind
 *     keine Historie, sondern Rauschen.
 *  3. **Sie wirkt nie auf das Modell zurück.** Der Effekt eines
 *     Chronik-Eintrags hängt NICHT am Reifier der Kante — sonst lägen
 *     alte Läufe über der aktuellen Annahme und niemand wüsste, welcher
 *     gilt (Invariante C4 bliebe formal gewahrt und wäre inhaltlich
 *     verletzt).
 */

import { describe, expect, it, vi } from 'vitest';
import type { Quad } from '@rdfjs/types';
import { OxigraphStore } from '@/lib/graph/store/oxigraph';
import { createIriFactory } from '@/lib/graph/iri';
import { namedNode } from '@/lib/graph/rdf';
import { OW } from '@/lib/graph/vocab';
import { createMemoryFileSystem } from '@/lib/platform/runtime/memfs';
import { restoreSnapshot, writeSnapshot } from '@/lib/graph/serialize/snapshot';
import { createCausalModel, readCausalModel } from '@/lib/graph/causal/model';
import { applyStructureOperation } from '@/lib/graph/causal/edit';
import { createEstimand } from '@/lib/graph/causal/estimand';
import { createVariable } from '@/lib/graph/observations/variables';
import { createRandom, normalDraw } from '@/lib/graph/causal/numeric';
import type { Observation } from '@/lib/graph/observations/types';
import {
    causalArchiveGraph,
    deleteArchiveEntry,
    hasChanged,
    readCausalArchive,
    type ArchiveEntryView,
} from '@/lib/graph/causal/archive';
import { runCausalStudies, type VariableMetadata } from '@/lib/graph/causal/study-graph';
import type { StudyResult } from '@/lib/graph/causal/study';

vi.setConfig({ testTimeout: 120_000 });

const INSTANCE_BASE = 'https://ws.example.org/id/';
const iri = createIriFactory(INSTANCE_BASE);
const variableIri = (id: string) => iri.entity('variable', id);
const START = Date.parse('2026-06-01T00:00:00.000Z');
const STEP_SECONDS = 300;

/** Konfundierte Welt wie in der C4-Abnahme: Z → T, Z → Y, T → Y. */
function world(rows: number, effect = 2, seed = 7) {
    const random = createRandom(seed);
    const z: number[] = [];
    const t: number[] = [];
    const y: number[] = [];
    for (let index = 0; index < rows; index += 1) {
        const zi = normalDraw(random);
        const ti = 1 / (1 + Math.exp(-1.5 * zi)) > random() ? 1 : 0;
        z.push(zi);
        t.push(ti);
        y.push(effect * ti + 3 * zi + 0.5 * normalDraw(random));
    }
    return { z, t, y };
}

function seriesOf(values: readonly number[]): Observation[] {
    return values.map((value, index) => ({ t: START + index * STEP_SECONDS * 1000, v: value }));
}

async function buildWorld(rows = 480) {
    const store = new OxigraphStore();
    const handle = { store, iri };
    const truth = world(rows);
    const series = new Map<string, Observation[]>([
        ['t', seriesOf(truth.t)],
        ['y', seriesOf(truth.y)],
        ['z', seriesOf(truth.z)],
    ]);

    for (const [id, kind] of [['t', 'binary'], ['y', 'numeric'], ['z', 'numeric']] as const) {
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
    await createCausalModel(handle, { id: 'wohnung', name: 'Wohnung' });
    for (const id of ['t', 'y', 'z'] as const) {
        await applyStructureOperation(handle, 'wohnung', {
            op: 'add-variable', iri: variableIri(id), name: id.toUpperCase(),
        });
    }
    for (const [from, to] of [['z', 't'], ['z', 'y'], ['t', 'y']] as const) {
        await applyStructureOperation(handle, 'wohnung', {
            op: 'add-edge', from: variableIri(from), to: variableIri(to), edgeClass: 'asserted',
        });
    }
    await createEstimand(handle, {
        id: 'frage',
        name: 'Wirkung von T auf Y',
        modelId: 'wohnung',
        treatment: variableIri('t'),
        outcome: variableIri('y'),
        estimator: 'regression',
        seed: 42,
    });

    const metadata: VariableMetadata[] = ['t', 'y', 'z'].map(id => ({
        iri: variableIri(id),
        id,
        name: id.toUpperCase(),
        kind: id === 't' ? 'binary' as const : 'numeric' as const,
        aggregation: id === 't' ? 'last' as const : 'mean' as const,
        intervalSeconds: STEP_SECONDS,
    }));

    const run = (at: string) => runCausalStudies(handle, metadata, {
        now: new Date(at),
        softwareVersion: '0.1.0-test',
        bootstrapSamples: 40,
        readSeries: async (variableId: string) => series.get(variableId) ?? [],
    });

    return { store, handle, run };
}

async function dump(store: OxigraphStore, graphIri: string): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const quad of store.dump(namedNode(graphIri))) quads.push(quad);
    return quads;
}

describe('Die Chronik hält fest, was wann gesagt wurde', () => {
    it('schreibt den ersten Lauf, den identischen zweiten aber nicht', async () => {
        const { store, handle, run } = await buildWorld();

        const first = await run('2026-08-14T10:00:00.000Z');
        expect(first.archived).toEqual(['frage']);
        const afterFirst = await readCausalArchive(handle);
        expect(afterFirst).toHaveLength(1);
        expect(afterFirst[0].estimandId).toBe('frage');
        expect(afterFirst[0].verdict).toBe('passed');
        expect(afterFirst[0].effect?.value).toBeGreaterThan(1.5);
        expect(afterFirst[0].softwareVersion).toBe('0.1.0-test');

        // Gleiche Daten, gleicher Seed, gleiches Modell → gleiche Antwort.
        // Ein zweiter Eintrag wäre Rauschen, keine Historie.
        const second = await run('2026-08-15T10:00:00.000Z');
        expect(second.archived).toEqual([]);
        expect(await readCausalArchive(handle)).toHaveLength(1);

        // Der Inferenz-Graph trägt trotzdem den neuen Lauf — er ist der
        // aktuelle Stand und wird bei jedem Lauf ersetzt (Invariante C4).
        const inferred = await dump(store, second.graph);
        expect(inferred.filter(quad => quad.predicate.value === OW.studyVerdict)).toHaveLength(1);
    });

    it('hält eine geänderte Modell-Revision fest — die Annahme war eine andere', async () => {
        const { handle, run } = await buildWorld();
        await run('2026-08-14T10:00:00.000Z');

        // Eine zusätzliche Variable ändert die Revision, ohne die Frage zu
        // berühren. Genau das muss die Chronik unterscheiden können.
        await applyStructureOperation(handle, 'wohnung', {
            op: 'add-variable', iri: variableIri('w'), name: 'W',
        });
        const second = await run('2026-08-16T10:00:00.000Z');
        expect(second.archived).toEqual(['frage']);

        const entries = await readCausalArchive(handle);
        expect(entries).toHaveLength(2);
        // Neueste zuerst — und die Revisionen unterscheiden sich.
        expect(entries[0].generatedAt > entries[1].generatedAt).toBe(true);
        expect(entries[0].modelRevision).toBeGreaterThan(entries[1].modelRevision);
    });

    it('hängt den Effekt eines Eintrags NIE an den Reifier der Kante', async () => {
        const { store, handle, run } = await buildWorld();
        await run('2026-08-14T10:00:00.000Z');

        const archive = await dump(store, causalArchiveGraph(iri));
        const effects = archive.filter(quad => quad.predicate.value === OW.effectSize);
        expect(effects).toHaveLength(1);
        // Der Träger ist studieneigen, nicht der Reifier — sonst legten
        // sich alte Läufe über die aktuelle Annahme.
        expect(effects[0].subject.value).toContain('/effect');
        expect(archive.some(quad => quad.predicate.value === OW.evidenceLevel)).toBe(false);
        expect(archive.some(quad => quad.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies'))
            .toBe(false);

        // Und im Modell-Graphen steht davon weiterhin nichts (Invariante C4).
        const modelQuads = await dump(store, iri.causalGraph('wohnung'));
        expect(modelQuads.some(quad => quad.predicate.value === OW.effectSize)).toBe(false);

        // Das Lesemodell des Modells sieht genau EINEN Effekt an der
        // Kante — den aktuellen aus dem Inferenz-Graphen.
        const model = await readCausalModel(handle, {
            modelId: 'wohnung',
            graph: iri.causalGraph('wohnung'),
        });
        const edge = model?.edges.find(candidate =>
            candidate.from === variableIri('t') && candidate.to === variableIri('y'));
        expect(edge?.effect).toBeDefined();
        expect(edge?.studyEvidence).toBe('refuted-clean');
    });

    it('verwirft einen Eintrag vollständig — samt Effekt, Eingaben und Refutationen', async () => {
        const { store, handle, run } = await buildWorld();
        await run('2026-08-14T10:00:00.000Z');
        const [entry] = await readCausalArchive(handle);
        expect(entry).toBeDefined();

        const before = await dump(store, causalArchiveGraph(iri));
        expect(before.length).toBeGreaterThan(10);

        expect(await deleteArchiveEntry(handle, entry.iri)).toBe(true);
        expect(await readCausalArchive(handle)).toEqual([]);
        // Nichts bleibt zurück: Die Teile eines Eintrags hängen unter
        // seiner Adresse, deshalb geht der ganze Baum mit.
        const after = await dump(store, causalArchiveGraph(iri));
        expect(after.some(quad => quad.subject.value.startsWith(entry.iri))).toBe(false);
        expect(after.some(quad => quad.predicate.value === OW.effectSize)).toBe(false);

        // Ein zweites Verwerfen ist kein Fehler, sondern ein „nichts da".
        expect(await deleteArchiveEntry(handle, entry.iri)).toBe(false);

        // Und der nächste Lauf hält wieder fest, was sich ändert — die
        // Chronik ist danach nicht kaputt, nur leer.
        const again = await run('2026-08-17T10:00:00.000Z');
        expect(again.archived).toEqual(['frage']);
        expect(await readCausalArchive(handle)).toHaveLength(1);
    });

    it('lässt die Einträge anderer Fragen beim Verwerfen unberührt', async () => {
        const { handle, run } = await buildWorld();
        await run('2026-08-14T10:00:00.000Z');
        await createEstimand(handle, {
            id: 'zweite-frage',
            name: 'Wirkung von Z auf Y',
            modelId: 'wohnung',
            treatment: variableIri('z'),
            outcome: variableIri('y'),
            estimator: 'regression',
            seed: 43,
        });
        await run('2026-08-18T10:00:00.000Z');
        expect(await readCausalArchive(handle)).toHaveLength(2);

        const target = (await readCausalArchive(handle, { estimandId: 'frage' }))[0];
        expect(await deleteArchiveEntry(handle, target.iri)).toBe(true);
        const rest = await readCausalArchive(handle);
        expect(rest).toHaveLength(1);
        expect(rest[0].estimandId).toBe('zweite-frage');
        expect(rest[0].effect).toBeDefined();
    });

    it('überlebt den Neustart — ein Ereignis lässt sich nicht neu rechnen', async () => {
        const { store, run } = await buildWorld();
        await run('2026-08-14T10:00:00.000Z');

        const files = createMemoryFileSystem();
        await files.mkdir('/snapshot');
        const report = await writeSnapshot(store, files, '/snapshot', INSTANCE_BASE);
        expect(report.written.map(entry => entry.file)).toContain('causal-archive.nq');
        // Der Inferenz-Graph gehört ausdrücklich NICHT dazu (§8.1).
        expect(report.written.some(entry => entry.file.includes('inferred'))).toBe(false);

        const fresh = new OxigraphStore();
        await restoreSnapshot(fresh, files, '/snapshot');
        const entries = await readCausalArchive({ store: fresh, iri });
        expect(entries).toHaveLength(1);
        expect(entries[0].effect?.value).toBeGreaterThan(1.5);
    });
});

describe('Die Regel, wann ein Eintrag entsteht', () => {
    const entry = (over: Partial<ArchiveEntryView> = {}): ArchiveEntryView => ({
        iri: 'urn:x',
        id: 'frage-20260814100000',
        estimandId: 'frage',
        name: 'Frage',
        verdict: 'passed',
        modelRevision: 7,
        generatedAt: '2026-08-14T10:00:00.000Z',
        reason: '',
        effect: { value: 2, ciLow: 1.6, ciHigh: 2.4 },
        ...over,
    });
    const result = (over: Partial<StudyResult> = {}): StudyResult => ({
        spec: { id: 'frage', treatment: 't', outcome: 'y', estimator: 'regression', seed: 42 },
        modelIri: 'urn:m',
        modelGraph: 'urn:g',
        modelRevision: 7,
        verdict: 'passed',
        identification: {
            identifiable: true, strategy: 'backdoor', adjustmentSets: [], reason: '',
            zeroEffect: false, missing: [], paths: [], truncated: false,
        } as unknown as StudyResult['identification'],
        adjustedFor: [],
        refutations: [],
        reason: '',
        effect: {
            estimator: 'regression', effect: 2, standardError: 0.2, ciLow: 1.6, ciHigh: 2.4,
            rows: 480, bootstrapSamples: 40, blockLength: 20, notes: [],
        },
        ...over,
    });

    it('schreibt beim ersten Mal immer', () => {
        expect(hasChanged(null, result())).toBe(true);
    });

    it('schweigt bei einer Verschiebung innerhalb der Unsicherheit', () => {
        const nudged = result({
            effect: {
                estimator: 'regression', effect: 2.1, standardError: 0.2, ciLow: 1.7, ciHigh: 2.5,
                rows: 480, bootstrapSamples: 40, blockLength: 20, notes: [],
            },
        });
        expect(hasChanged(entry(), nudged)).toBe(false);
    });

    it('schreibt bei geändertem Urteil, geänderter Revision und echtem Sprung', () => {
        expect(hasChanged(entry(), result({ verdict: 'refuted', effect: undefined }))).toBe(true);
        expect(hasChanged(entry(), result({ modelRevision: 8 }))).toBe(true);
        const jumped = result({
            effect: {
                estimator: 'regression', effect: 5, standardError: 0.3, ciLow: 4.4, ciHigh: 5.6,
                rows: 480, bootstrapSamples: 40, blockLength: 20, notes: [],
            },
        });
        expect(hasChanged(entry(), jumped)).toBe(true);
    });
});
