// @vitest-environment node
/**
 * Abnahme der Nacharbeit „Studien auf grobem Raster rechnen lassen"
 * (TODO.md, Kausal-Layer; CAUSAL_LAYER_SPEC §6/§13.1 und §15.5).
 *
 * **Der Befund, gegen den das gebaut ist.** Der Rückgriff auf die
 * Long-Term-Statistics verlängert den Bestand nach hinten, aber in
 * Stundenschritten — die Erfassungsregel der Größe bleibt dabei ihr
 * feines Raster (`ow:samplingInterval`, z. B. PT5M), nur die alte
 * Strecke hat pro Stunde genau einen Punkt (`ow:aggregateInterval`
 * PT1H). Das Panel liest einen Wert nur so lange, wie das Raster SEINER
 * Reihe reicht; auf dem feinen Raster fallen dort deshalb elf von zwölf
 * Rasterpunkten als Lücke heraus. Das ist die konservative Seite
 * (verlieren statt erfinden) — sie kostet aber das Zeilenbudget: Die
 * Kappung greift, bevor die alte Strecke überhaupt erreicht ist.
 *
 * **Was hier geprüft wird:**
 *
 *  1. Ein an der Frage gesetztes Rechenraster (`ow:studyInterval`) holt
 *     die alte Strecke zurück — ohne einen einzigen Wert zu erfinden.
 *  2. Ein feineres Raster als die gröbste beteiligte Reihe wird
 *     **abgelehnt** und nicht stillschweigend angehoben: Verfeinern
 *     hieße Werte erfinden, und das ist genau das, was der Ausbau NICHT
 *     sein darf.
 *  3. Das Raster ist Teil der Signatur (Invariante C7): Es steht an der
 *     Frage, an der Studie und in der Chronik — eine Zeilenzahl ohne ihr
 *     Raster wäre eine Zahl ohne Maßstab.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Quad } from '@rdfjs/types';
import { OxigraphStore } from '@/lib/graph/store/oxigraph';
import { createIriFactory } from '@/lib/graph/iri';
import { namedNode } from '@/lib/graph/rdf';
import { OW } from '@/lib/graph/vocab';
import { parseRdf } from '@/lib/graph/serialize/io';
import { validateQuads } from '@/lib/graph/reasoning/shacl';
import { createCausalModel } from '@/lib/graph/causal/model';
import { applyStructureOperation } from '@/lib/graph/causal/edit';
import { createEstimand, estimandQuads, getEstimand } from '@/lib/graph/causal/estimand';
import { createVariable, listVariables } from '@/lib/graph/observations/variables';
import type { Observation } from '@/lib/graph/observations/types';
import { buildPanel, formatInterval, type PanelSeries } from '@/lib/graph/causal/panel';
import { createRandom, normalDraw } from '@/lib/graph/causal/numeric';
import { runCausalStudies, readCausalStudies, type VariableMetadata } from '@/lib/graph/causal/study-graph';

vi.setConfig({ testTimeout: 60_000 });

const iri = createIriFactory('https://ws.example.org/id/');
const variableIri = (id: string) => iri.entity('variable', id);

const START = Date.parse('2026-01-01T00:00:00.000Z');
const HOUR = 3_600_000;
const FINE_SECONDS = 300;

/** Tage, die nur aus Stundenaggregaten bestehen (der Rückgriff, §15.5). */
const AGGREGATE_DAYS = 30;
/** Tage, die die Erfassung selbst geschrieben hat (feines Raster). */
const CAPTURED_DAYS = 2;
const AGGREGATE_POINTS = AGGREGATE_DAYS * 24;
const CAPTURED_POINTS = (CAPTURED_DAYS * 86_400) / FINE_SECONDS;
/** Erster Zeitstempel der feinen Strecke. */
const CAPTURE_START = START + AGGREGATE_POINTS * HOUR;

/**
 * Eine Reihe, wie sie nach einem Rückgriff wirklich im
 * Beobachtungs-Speicher liegt: hinten stündlich (aus Aggregaten), vorn
 * im Fünf-Minuten-Raster (erfasst). Die Erfassungsregel der Größe ist in
 * beiden Abschnitten dieselbe — nur der Bestand ist es nicht.
 */
function backfilledSeries(values: (index: number, at: number) => number): Observation[] {
    const points: Observation[] = [];
    for (let index = 0; index < AGGREGATE_POINTS; index += 1) {
        const at = START + index * HOUR;
        points.push({ t: at, v: values(index, at) });
    }
    for (let index = 0; index < CAPTURED_POINTS; index += 1) {
        const at = CAPTURE_START + index * FINE_SECONDS * 1000;
        points.push({ t: at, v: values(AGGREGATE_POINTS + index, at) });
    }
    return points;
}

function panelSeries(key: string, observations: readonly Observation[]): PanelSeries {
    return { key, kind: 'numeric', intervalSeconds: FINE_SECONDS, observations };
}

describe('Abnahme 1: die aus Aggregaten nachgefüllte Strecke wird rechenbar', () => {
    // Zwei numerische Größen, beide mit Erfassungsregel PT5M und beide
    // nach hinten aus Stundenaggregaten verlängert — der Normalfall nach
    // einem Backfill.
    const random = createRandom(11);
    const treatment = backfilledSeries(index => 18 + (index % 7));
    const outcome = backfilledSeries(index => 2 * (18 + (index % 7)) + normalDraw(random));
    const series = [
        panelSeries(variableIri('vorlauf'), treatment),
        panelSeries(variableIri('verbrauch'), outcome),
    ];
    // Dasselbe Zeilenbudget wie im Produktivpfad, nur klein genug, dass
    // es in einem Test greift. Es ist der Grund, warum das feine Raster
    // teuer ist: Es wird für Rasterpunkte ausgegeben, an denen nie ein
    // Wert stehen kann.
    const maxRows = 1000;

    it('erreicht sie auf dem feinen Raster gar nicht — das Budget ist vorher verbraucht', () => {
        const panel = buildPanel(series, { maxRows });
        expect(panel.intervalSeconds).toBe(FINE_SECONDS);
        expect(panel.intervalSource).toBe('series');
        expect(panel.truncated).toBe(true);
        // Die Kappung greift am älteren Ende: Von 32 Tagen bleiben knapp
        // dreieinhalb übrig, und die alte Strecke ist damit unerreichbar.
        expect(panel.from).toBeGreaterThan(START + 20 * 86_400_000);
    });

    it('verliert dort elf von zwölf Rasterpunkten als Lücke', () => {
        // Nur die alte Strecke, ohne Kappung: Auf dem Fünf-Minuten-Raster
        // hat exakt jeder zwölfte Punkt einen Wert — die übrigen elf sind
        // Lücke, weil dort nie etwas gemessen wurde.
        const panel = buildPanel(series, { through: CAPTURE_START - 1 });
        expect(panel.rows).toBe(AGGREGATE_POINTS);
        expect(panel.candidateRows).toBe(AGGREGATE_POINTS * 12);
        expect(panel.column(variableIri('vorlauf'))?.droppedRows).toBe(
            panel.candidateRows - panel.rows,
        );
    });

    it('rechnet sie auf dem gesetzten Stundenraster vollständig', () => {
        const panel = buildPanel(series, { maxRows, intervalSeconds: 3600 });
        expect(panel.intervalSeconds).toBe(3600);
        expect(panel.intervalSource).toBe('requested');
        expect(panel.truncated).toBe(false);
        // Der Bestand beginnt wieder am Anfang — 32 Tage statt drei.
        expect(panel.from).toBe(START);
        expect(panel.rows).toBeGreaterThan(700);
        // Keine einzige Zeile scheitert mehr an einer Lücke: Auf diesem
        // Raster wird nur gefragt, wo die Reihe auch geantwortet hat.
        expect(panel.column(variableIri('vorlauf'))?.droppedRows).toBe(0);
    });

    it('erfindet dabei nichts — die alten Zeilen sind die gemessenen Stundenwerte', () => {
        const panel = buildPanel(series, { maxRows, intervalSeconds: 3600 });
        const column = panel.column(variableIri('vorlauf'));
        expect(column).toBeDefined();
        // Zeile für Zeile derselbe Wert wie im Speicher, in derselben
        // Reihenfolge. Ein Fortschreiben des Stundenwerts (die verbotene
        // Variante) müsste hier Wiederholungen erzeugen.
        const expected = treatment.slice(0, AGGREGATE_POINTS).map(point => point.v as number);
        expect(column?.values.slice(0, AGGREGATE_POINTS)).toEqual(expected);
        expect(panel.timestamps.slice(0, AGGREGATE_POINTS)).toEqual(
            treatment.slice(0, AGGREGATE_POINTS).map(point => point.t),
        );
    });

    it('gewinnt Zeilen, ohne mehr Beobachtungen zu benutzen', () => {
        const fine = buildPanel(series, { maxRows });
        const coarse = buildPanel(series, { maxRows, intervalSeconds: 3600 });
        expect(coarse.rows).toBeGreaterThan(fine.rows);
        // Die Obergrenze der Ehrlichkeit: Mehr Zeilen als Stundenpunkte
        // im gemeinsamen Fenster kann es nicht geben.
        expect(coarse.rows).toBeLessThanOrEqual(AGGREGATE_POINTS + CAPTURED_DAYS * 24);
    });
});

describe('Abnahme 2: verfeinern wird abgelehnt, nicht stillschweigend angehoben', () => {
    const series = [
        panelSeries(variableIri('a'), backfilledSeries(index => index)),
        {
            key: variableIri('b'),
            kind: 'numeric' as const,
            intervalSeconds: 3600,
            observations: backfilledSeries(index => index * 2),
        },
    ];

    it('lehnt ein Raster ab, das feiner ist als die gröbste beteiligte Reihe', () => {
        const panel = buildPanel(series, { intervalSeconds: 900 });
        expect(panel.rows).toBe(0);
        expect(panel.intervalSource).toBe('requested');
        // Das gesetzte Raster bleibt im Ergebnis stehen: Es stumm auf die
        // gröbste Reihe anzuheben hieße, eine Studie mit einem Raster zu
        // schreiben, nach dem niemand gefragt hat.
        expect(panel.intervalSeconds).toBe(900);
        expect(panel.problem).toContain('verfeinern nicht');
        expect(panel.problem).toContain(formatInterval(3600));
    });

    it('nimmt dasselbe Raster an, sobald es nicht feiner ist', () => {
        const panel = buildPanel(series, { intervalSeconds: 3600 });
        expect(panel.rows).toBeGreaterThan(0);
        expect(panel.intervalSeconds).toBe(3600);
    });

    it('nennt bei leerem Panel das gerechnete Raster als möglichen Ausweg', () => {
        // Zwei Reihen, die sich auf dem feinen Raster nie gleichzeitig
        // äußern: A nur zur vollen Stunde, B nur zur halben.
        const panel = buildPanel([
            {
                key: 'a',
                kind: 'numeric',
                intervalSeconds: FINE_SECONDS,
                observations: [0, 1, 2].map(index => ({ t: START + index * HOUR, v: index })),
            },
            {
                key: 'b',
                kind: 'numeric',
                intervalSeconds: FINE_SECONDS,
                observations: [0, 1, 2].map(index => ({ t: START + index * HOUR + HOUR / 2, v: index })),
            },
        ]);
        expect(panel.rows).toBe(0);
        expect(panel.problem).toContain('gröberes');
    });
});

// --- Der Produktivpfad: Frage, Lauf, Signatur ----------------------------

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

/**
 * Modell, Größen und Reihen wie im Betrieb: Der DAG steht im Store, die
 * Erfassungsregeln in `graph/meta`, die Werte daneben (Invariante C3).
 * Alle drei Größen tragen die feine Erfassungsregel, ihr Bestand ist
 * aber stündlich — genau die Lage nach einem Rückgriff.
 */
async function buildBackfilledWorld() {
    const store = new OxigraphStore();
    const handle = { store, iri };
    await store.load(shapesQuads(), namedNode(iri.sharedGraph('shapes')), { replace: true });
    await createCausalModel(handle, { id: 'wohnung', name: 'Wohnung' });

    const random = createRandom(23);
    const values = new Map<string, Observation[]>();
    const z: number[] = [];
    const t: number[] = [];
    const y: number[] = [];
    for (let index = 0; index < AGGREGATE_POINTS; index += 1) {
        const zi = normalDraw(random);
        const ti = 5 + 2 * zi + normalDraw(random);
        // Die gesetzte Wahrheit: t wirkt mit 2 auf y, z konfundiert.
        y.push(2 * ti + 3 * zi + 0.5 * normalDraw(random));
        z.push(zi);
        t.push(ti);
    }
    const hourly = (list: readonly number[]): Observation[] =>
        list.map((value, index) => ({ t: START + index * HOUR, v: value }));
    values.set('z', hourly(z));
    values.set('t', hourly(t));
    values.set('y', hourly(y));

    for (const id of ['z', 't', 'y']) {
        await createVariable(handle, {
            id,
            name: id.toUpperCase(),
            sourceKind: 'test',
            source: `sensor.${id}`,
            kind: 'numeric',
            aggregation: 'mean',
            // Die Erfassungsregel bleibt fein, auch wenn der Bestand
            // stündlich ist — das ist der ganze Punkt.
            intervalSeconds: FINE_SECONDS,
            unit: 'kWh',
        });
        await applyStructureOperation(handle, 'wohnung', {
            op: 'add-variable',
            iri: variableIri(id),
            name: id.toUpperCase(),
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

    const metadata: VariableMetadata[] = (await listVariables(handle)).map(view => ({
        iri: view.iri,
        id: view.id,
        name: view.name,
        kind: view.kind,
        aggregation: view.aggregation,
        intervalSeconds: view.intervalSeconds,
        ...(view.unit ? { unit: view.unit } : {}),
    }));
    return { store, handle, metadata, values };
}

function runOptions(values: ReadonlyMap<string, Observation[]>) {
    return {
        now: new Date('2026-02-05T10:00:00.000Z'),
        softwareVersion: '0.1.0-test',
        bootstrapSamples: 40,
        readSeries: async (variableId: string) => values.get(variableId) ?? [],
    };
}

describe('Das Raster an der Frage (ow:studyInterval)', () => {
    it('steht als xsd:duration in graph/meta und kommt so zurück', async () => {
        const store = new OxigraphStore();
        const handle = { store, iri };
        await createCausalModel(handle, { id: 'wohnung', name: 'Wohnung' });
        const created = await createEstimand(handle, {
            id: 'stundenfrage',
            name: 'Bringt die Vorlauftemperatur etwas?',
            modelId: 'wohnung',
            treatment: variableIri('t'),
            outcome: variableIri('y'),
            estimator: 'auto',
            seed: 42,
            intervalSeconds: 3600,
        });
        expect(created.intervalSeconds).toBe(3600);

        const quads = await dump(store, iri.sharedGraph('meta'));
        const interval = quads.find(quad => quad.predicate.value === OW.studyInterval);
        expect(interval?.object.value).toBe('PT1H');
        expect(interval?.object.termType === 'Literal' && interval.object.datatype.value)
            .toContain('duration');

        const read = await getEstimand(handle, 'stundenfrage');
        expect(read?.intervalSeconds).toBe(3600);
    });

    it('bleibt weg, wenn niemand es gesetzt hat — geraten wird nichts', async () => {
        const store = new OxigraphStore();
        const handle = { store, iri };
        await createCausalModel(handle, { id: 'wohnung', name: 'Wohnung' });
        await createEstimand(handle, {
            id: 'ohne-raster',
            name: 'Ohne Raster',
            modelId: 'wohnung',
            treatment: variableIri('t'),
            outcome: variableIri('y'),
            estimator: 'auto',
            seed: 42,
        });
        const read = await getEstimand(handle, 'ohne-raster');
        expect(read?.intervalSeconds).toBeUndefined();
        const quads = await dump(store, iri.sharedGraph('meta'));
        expect(quads.some(quad => quad.predicate.value === OW.studyInterval)).toBe(false);
    });

    it('lehnt ein unsinniges Raster schon an der Frage ab', async () => {
        const store = new OxigraphStore();
        const handle = { store, iri };
        await createCausalModel(handle, { id: 'wohnung', name: 'Wohnung' });
        await expect(createEstimand(handle, {
            id: 'kaputt',
            name: 'Kaputt',
            modelId: 'wohnung',
            treatment: variableIri('t'),
            outcome: variableIri('y'),
            estimator: 'auto',
            seed: 42,
            intervalSeconds: 0,
        })).rejects.toThrow(/Rechenraster/);
    });

    it('besteht die Shapes und verträgt kein zweites Raster', async () => {
        const shapes = shapesQuads();
        const view = {
            id: 'stundenfrage',
            iri: iri.entity('estimand', 'stundenfrage'),
            name: 'Stundenfrage',
            modelId: 'wohnung',
            modelIri: iri.entity('causal-model', 'wohnung'),
            treatment: variableIri('t'),
            outcome: variableIri('y'),
            estimator: 'auto' as const,
            seed: 42,
            intervalSeconds: 3600,
        };
        const graph = namedNode(iri.sharedGraph('meta'));
        const clean = estimandQuads(iri, view, graph);
        expect((await validateQuads(shapes, clean)).conforms).toBe(true);

        const twice = [...clean, ...estimandQuads(iri, { ...view, intervalSeconds: 900 }, graph)];
        const report = await validateQuads(shapes, twice);
        expect(report.results.some(entry => entry.message.includes('Rechenraster'))).toBe(true);
    });
});

describe('Der Lauf rechnet auf dem gesetzten Raster und sagt es (Signatur, C7)', () => {
    it('holt die alte Strecke zurück, statt sie am Zeilenbudget zu verlieren', async () => {
        const world = await buildBackfilledWorld();
        await createEstimand(world.handle, {
            id: 'grob',
            name: 'Vorlauf auf Verbrauch, stündlich',
            modelId: 'wohnung',
            treatment: variableIri('t'),
            outcome: variableIri('y'),
            estimator: 'regression',
            seed: 42,
            intervalSeconds: 3600,
        });
        const summary = await runCausalStudies(world.handle, world.metadata, {
            ...runOptions(world.values),
            // Das Budget ist knapp: Für die 720 Stundenzeilen reicht es,
            // für 8.640 Fünf-Minuten-Rasterpunkte nicht — und genau da
            // entscheidet sich, ob die alte Strecke gerechnet wird.
            maxRows: 800,
        });
        expect(summary.rejected).toEqual([]);
        const [result] = summary.results;
        expect(result.dataset?.intervalSeconds).toBe(3600);
        expect(result.dataset?.intervalSource).toBe('requested');
        expect(result.dataset?.rows).toBeGreaterThan(400);
        expect(result.dataset?.from).toBe(START);

        const studies = await readCausalStudies(world.handle);
        expect(studies[0]?.intervalSeconds).toBe(3600);
    });

    it('schreibt das Raster auch dann, wenn es aus der gröbsten Reihe kam', async () => {
        const world = await buildBackfilledWorld();
        await createEstimand(world.handle, {
            id: 'auto',
            name: 'Vorlauf auf Verbrauch, automatisch',
            modelId: 'wohnung',
            treatment: variableIri('t'),
            outcome: variableIri('y'),
            estimator: 'regression',
            seed: 42,
        });
        const summary = await runCausalStudies(world.handle, world.metadata, {
            ...runOptions(world.values),
            maxRows: 800,
        });
        const [result] = summary.results;
        expect(result.dataset?.intervalSeconds).toBe(FINE_SECONDS);
        expect(result.dataset?.intervalSource).toBe('series');

        const quads = await dump(world.store, summary.graph);
        const interval = quads.find(quad => quad.predicate.value === OW.studyInterval);
        expect(interval?.object.value).toBe('PT5M');

        // Ohne gesetztes Raster bleibt der Lauf am jüngeren Rand hängen —
        // das ist der Befund, gegen den die Einstellung gebaut ist.
        expect(result.dataset?.from).toBeGreaterThan(START);
        expect(result.dataset?.rows).toBeLessThan(AGGREGATE_POINTS / 4);
    });

    it('gibt bei einem zu feinen Raster keine Zahl, sondern die Begründung', async () => {
        const world = await buildBackfilledWorld();
        await createEstimand(world.handle, {
            id: 'zu-fein',
            name: 'Zu fein gefragt',
            modelId: 'wohnung',
            treatment: variableIri('t'),
            outcome: variableIri('y'),
            estimator: 'regression',
            seed: 42,
            // Feiner als die Erfassungsregel PT5M der beteiligten Reihen.
            intervalSeconds: 60,
        });
        const summary = await runCausalStudies(world.handle, world.metadata, runOptions(world.values));
        const [result] = summary.results;
        expect(result.verdict).toBe('not-estimable');
        expect(result.effect).toBeUndefined();
        expect(result.reason).toContain('verfeinern nicht');

        // Und im Graphen steht kein Raster, weil es kein Panel gab: Eine
        // Studie ohne Datensatz behauptet auch keinen Maßstab.
        const quads = await dump(world.store, summary.graph);
        expect(quads.some(quad => quad.predicate.value === OW.studyInterval)).toBe(false);
    });
});
