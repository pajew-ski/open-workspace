// @vitest-environment node
/**
 * Abnahme C5 — Open-Data-Connector und Confounder-Katalog
 * (CAUSAL_LAYER_SPEC §10/§11, §16, §19).
 *
 * Die Spec verlangt genau einen Nachweis, und er steht ganz unten in
 * dieser Datei:
 *
 *   **Dieselbe Frage mit und ohne Adjustierung liefert nachweislich
 *   unterschiedliche Ergebnisse, und die Differenz wird erklärt.**
 *
 * Er wird über die ganze Kette geführt, nicht an einem Zwischenstück:
 * Connector anlegen → Struktur importieren → Größe aus der
 * Kandidatenliste aufnehmen → Werte erfassen → Studie rechnen. Vorher
 * lautet die Antwort „nicht identifizierbar, weil die Außentemperatur
 * nicht erfasst wird" (C1/C4), nachher steht eine Zahl da — und daneben
 * die Zahl, die ohne die Störgröße herausgekommen wäre.
 *
 * Dazu, was den Meilenstein trägt:
 *  - die Abbildung offener APIs in ihren drei verbreiteten Formen
 *    (Datensatzliste, Spalten-Arrays, Zeitspannen),
 *  - der Vertrag: EIN Connector, Struktur im Graphen, **kein Messwert**
 *    im Store (Invariante C3),
 *  - Zwischenspeicher und Fehlertoleranz,
 *  - und die Fehlerisolation zwischen Quellarten: Ein fehlender
 *    Home-Assistant-Zugang legt die Wetterreihe nicht mit still.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Quad } from '@rdfjs/types';
import { OxigraphStore } from '@/lib/graph/store/oxigraph';
import { createIriFactory } from '@/lib/graph/iri';
import { namedNode } from '@/lib/graph/rdf';
import { DCTERMS, OW, SCHEMA, SOSA, SSN } from '@/lib/graph/vocab';
import { createMemoryFileSystem } from '@/lib/platform/runtime/memfs';
import { createConnector } from '@/lib/graph/connectors/registry';
import { syncConnector } from '@/lib/graph/connectors/sync';
import { getConnectorKind } from '@/lib/graph/connectors/catalog';
import {
    mappingForConfig,
    restTimeseriesConnector,
    type RestTimeseriesConfig,
} from '@/lib/graph/connectors/rest-timeseries';
import {
    availableSeriesKeys,
    extractSeries,
    parseCsv,
    parseTimestamp,
    requestUrls,
    type RestSourceMapping,
} from '@/lib/graph/connectors/rest-timeseries/mapping';
import { REST_PRESETS, getRestPreset } from '@/lib/graph/connectors/rest-timeseries/presets';
import { resetRestTimeseriesCache } from '@/lib/graph/connectors/rest-timeseries/client';
import { restSourceKey } from '@/lib/graph/connectors/rest-timeseries/structure';
import { solarPosition } from '@/lib/graph/connectors/solar-position/astronomy';
import { SOLAR_PROCEDURE_ID, solarPositionConnector } from '@/lib/graph/connectors/solar-position';
import { classifyColumn, inventoryFromCsv } from '@/lib/graph/connectors/csv-observations';
import { ObservationStore } from '@/lib/graph/observations/store';
import { createVariable, listVariables } from '@/lib/graph/observations/variables';
import { listCaptureCandidates } from '@/lib/graph/observations/candidates';
import { captureObservations } from '@/lib/graph/observations/capture';
import { variableIdFor } from '@/lib/graph/observations/naming';
import type { Observation } from '@/lib/graph/observations/types';
import { createCausalModel } from '@/lib/graph/causal/model';
import { applyStructureOperation } from '@/lib/graph/causal/edit';
import { createEstimand } from '@/lib/graph/causal/estimand';
import { createRandom, normalDraw } from '@/lib/graph/causal/numeric';
import {
    causalInferredGraph,
    readCausalStudies,
    runCausalStudies,
    type VariableMetadata,
} from '@/lib/graph/causal/study-graph';

/** Studienläufe rechnen wirklich — Bootstrap und Refutationen brauchen Zeit. */
vi.setConfig({ testTimeout: 120_000 });

const INSTANCE_BASE = 'https://ws.example.org/id/';
const ROOT = '/data';
const HOUR = 3_600_000;

function newHandle() {
    return { store: new OxigraphStore(), iri: createIriFactory(INSTANCE_BASE) };
}

beforeEach(() => {
    // Der Zwischenspeicher ist prozessweit — ohne Rücksetzen sähe der
    // nächste Test die Antwort des vorigen.
    resetRestTimeseriesCache();
});

// --- Die Abbildung offener APIs (rein) -----------------------------------

describe('Abbildung: die drei Formen, in denen offene Kataloge liefern', () => {
    const base: Omit<RestSourceMapping, 'shape' | 'series' | 'timeField' | 'timeFormat'> = {
        label: 'Test',
        url: 'https://example.org/api',
        format: 'json',
        query: {},
        windowMode: 'range',
        fromParam: 'from',
        toParam: 'to',
        windowFormat: 'unix-ms',
        windowDays: 7,
        attribution: '',
        minRequestIntervalMs: 0,
        cacheTtlMs: 0,
    };
    const window = { from: 0, through: 10 * HOUR };

    it('liest eine Datensatzliste (Bright Sky, aWATTar) und rechnet Einheiten um', () => {
        const mapping: RestSourceMapping = {
            ...base,
            shape: 'points',
            path: 'data',
            timeField: 'ts',
            timeFormat: 'iso',
            series: [
                { key: 'temp', name: 'Temperatur', kind: 'numeric', aggregation: 'mean', field: 'temperature' },
                // €/MWh → ct/kWh: Der Faktor gehört in die Abbildung, nicht
                // in den Kopf des Lesers.
                { key: 'preis', name: 'Preis', kind: 'numeric', aggregation: 'mean', field: 'marketprice', scale: 0.1 },
            ],
        };
        const body = JSON.stringify({
            data: [
                { ts: '2026-06-01T00:00:00Z', temperature: 12.5, marketprice: 80 },
                { ts: '2026-06-01T01:00:00Z', temperature: null, marketprice: 95 },
            ],
        });
        const result = extractSeries(mapping, body, window);
        expect(result.problem).toBeUndefined();
        expect(result.series.get('temp')).toEqual([
            { t: Date.parse('2026-06-01T00:00:00Z'), value: 12.5 },
            // Eine Lücke bleibt eine Lücke (C3) — nicht der letzte Wert.
            { t: Date.parse('2026-06-01T01:00:00Z'), value: null, gap: 'unavailable' },
        ]);
        expect(result.series.get('preis')?.map(point => point.value)).toEqual([8, 9.5]);
    });

    it('liest parallele Spalten-Arrays (Open-Meteo) index-treu', () => {
        const mapping: RestSourceMapping = {
            ...base,
            shape: 'columns',
            path: 'hourly',
            timeField: 'time',
            timeFormat: 'unix-s',
            series: [
                {
                    key: 'strahlung', name: 'Globalstrahlung', kind: 'numeric', aggregation: 'mean',
                    field: 'shortwave_radiation',
                },
                { key: 'fehlt', name: 'Gibt es nicht', kind: 'numeric', aggregation: 'mean', field: 'nicht_da' },
            ],
        };
        const body = JSON.stringify({ hourly: { time: [0, 3600, 7200], shortwave_radiation: [0, 120, 340] } });
        const result = extractSeries(mapping, body, window);
        expect(result.series.get('strahlung')?.map(point => [point.t, point.value])).toEqual([
            [0, 0], [3_600_000, 120], [7_200_000, 340],
        ]);
        // Eine Spalte, die es nicht gibt, wird nicht erfunden.
        expect(result.series.get('fehlt')).toEqual([]);
        expect(availableSeriesKeys(mapping, body)).toEqual(['strahlung']);
    });

    it('macht aus Zeitspannen eine Stufenreihe mit Wert außerhalb (Feiertage)', () => {
        const mapping: RestSourceMapping = {
            ...base,
            shape: 'intervals',
            timeField: 'date',
            timeFormat: 'date',
            durationDays: 1,
            series: [{
                key: 'feiertag', name: 'Feiertag', kind: 'binary', aggregation: 'max', field: '',
                constantValue: 1, defaultValue: 0,
                filter: { field: 'counties', includes: 'DE-BY', whenAbsent: 'include' },
            }],
        };
        const body = JSON.stringify([
            { date: '2026-06-02', name: 'Bundesweit', counties: null },
            { date: '2026-06-03', name: 'Nur Bayern', counties: ['DE-BY'] },
            { date: '2026-06-04', name: 'Nur Hessen', counties: ['DE-HE'] },
        ]);
        const from = Date.parse('2026-06-01T00:00:00Z');
        const points = extractSeries(mapping, body, { from, through: from + 5 * 24 * HOUR })
            .series.get('feiertag') ?? [];
        const at = (iso: string) => points.filter(point => point.t === Date.parse(iso)).map(point => point.value);
        expect(at('2026-06-01T00:00:00Z')).toEqual([0]);
        expect(at('2026-06-02T00:00:00Z')).toEqual([1]);
        expect(at('2026-06-03T00:00:00Z')).toEqual([0, 1]);
        // Der hessische Feiertag taucht nicht auf — der Filter gilt.
        expect(at('2026-06-04T00:00:00Z')).toEqual([0]);
    });

    it('liest ein reines Datum als UTC-Mitternacht, nicht als Ortszeit', () => {
        expect(parseTimestamp('2026-06-01', 'date')).toBe(Date.parse('2026-06-01T00:00:00Z'));
        expect(parseTimestamp(1_700_000, 'unix-s')).toBe(1_700_000_000);
        expect(parseTimestamp('kein Datum', 'iso')).toBeNull();
    });

    it('liest CSV über die Kopfzeile, nie über die Spaltenposition', () => {
        const records = parseCsv('zeit;wert;name\n2026-06-01;3,5;"Mit ; Semikolon"\n', ';');
        expect(records).toEqual([{ zeit: '2026-06-01', wert: '3,5', name: 'Mit ; Semikolon' }]);
    });

    it('zerlegt ein langes Fenster in höfliche Anfragen', () => {
        const mapping: RestSourceMapping = {
            ...base, shape: 'points', timeField: 't', timeFormat: 'unix-ms', windowDays: 2, series: [],
        };
        const urls = requestUrls(mapping, 0, 5 * 24 * HOUR);
        expect(urls).toHaveLength(3);
        expect(urls[0]).toContain('from=0');
        expect(urls[0]).toContain(`to=${2 * 24 * HOUR}`);
    });
});

// --- Der Katalog ---------------------------------------------------------

describe('Confounder-Katalog (§10)', () => {
    it('führt Wetter, Strompreis, Einstrahlung und Feiertage — und sonst nichts', () => {
        expect(REST_PRESETS.map(preset => preset.id)).toEqual([
            'brightsky-weather', 'awattar-price', 'open-meteo-radiation', 'nager-holidays',
        ]);
        for (const preset of REST_PRESETS) {
            expect(preset.causalRole.length).toBeGreaterThan(20);
        }
    });

    it('baut aus der Wetter-Vorlage eine vollständige Abbildung mit Ort und Quellenangabe', () => {
        const mapping = getRestPreset('brightsky-weather')?.build({
            latitude: '52.52', longitude: '13.4', placeName: 'Zuhause',
        });
        expect(mapping?.url).toBe('https://api.brightsky.dev/weather');
        expect(mapping?.query.lat).toBe('52.52');
        expect(mapping?.place).toEqual({ name: 'Zuhause', latitude: 52.52, longitude: 13.4 });
        expect(mapping?.series.find(entry => entry.key === 'temperature')?.unit).toBe('°C');
        expect(mapping?.attribution).toContain('DWD');
    });

    it('verlangt die Pflichtangaben einer Vorlage, statt eine halbe Quelle anzulegen', () => {
        expect(() => mappingForConfig({ preset: 'brightsky-weather', params: {}, mapping: '' }))
            .toThrow(/Breitengrad/);
        expect(() => mappingForConfig({ preset: 'gibt-es-nicht', params: {}, mapping: '' }))
            .toThrow(/Unbekannte Vorlage/);
        expect(() => mappingForConfig({ preset: 'custom', params: {}, mapping: '{"label":"X"}' }))
            .toThrow(/unvollständig/);
    });

    it('hält den Locator verlustfrei — Vorlage wie eigene Abbildung', () => {
        const preset: RestTimeseriesConfig = {
            preset: 'nager-holidays',
            params: { country: 'DE', subdivision: 'DE-BY' },
            mapping: '',
        };
        expect(restTimeseriesConnector.configFromLocator(restTimeseriesConnector.locatorFor(preset)))
            .toEqual(preset);

        const custom: RestTimeseriesConfig = {
            preset: 'custom',
            params: {},
            mapping: JSON.stringify({
                label: 'Eigene', url: 'https://example.org/a', timeField: 't',
                series: [{ key: 'k', name: 'K', kind: 'numeric', aggregation: 'mean', field: 'v' }],
            }),
        };
        expect(restTimeseriesConnector.configFromLocator(restTimeseriesConnector.locatorFor(custom)))
            .toEqual(custom);
    });
});

// --- Der Connector im Vertrag -------------------------------------------

/**
 * Eine synthetische Wetterquelle. Sie verhält sich wie eine echte: Sie
 * liefert stündliche Werte für JEDES angefragte Fenster — auch für das
 * kurze Fenster, mit dem der Connector ihre Erreichbarkeit prüft.
 */
function weatherRoutes(
    valueAt: (t: number) => number | null,
    extra: (t: number) => Record<string, unknown> = () => ({}),
) {
    const log: string[] = [];
    const fetchImpl = (async (url: string): Promise<Response> => {
        log.push(url);
        const parsed = new URL(url);
        const from = Number(parsed.searchParams.get('from') ?? '0');
        const to = Number(parsed.searchParams.get('to') ?? String(from + HOUR));
        const data: Array<Record<string, unknown>> = [];
        const first = Math.ceil(from / HOUR) * HOUR;
        for (let t = first; t <= to && data.length < 5_000; t += HOUR) {
            data.push({ t, temperature: valueAt(t), ...extra(t) });
        }
        return new Response(JSON.stringify({ data }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }) as unknown as typeof fetch;
    return { fetchImpl, log };
}

function weatherMapping(): RestSourceMapping {
    return {
        label: 'Wetter (Test)',
        url: 'https://example.org/weather',
        format: 'json',
        shape: 'points',
        query: {},
        windowMode: 'range',
        fromParam: 'from',
        toParam: 'to',
        windowFormat: 'unix-ms',
        windowDays: 30,
        path: 'data',
        timeField: 't',
        timeFormat: 'unix-ms',
        series: [{
            key: 'temperature',
            name: 'Außentemperatur',
            kind: 'numeric',
            aggregation: 'mean',
            field: 'temperature',
            unit: '°C',
            observable: 'temperature',
            role: 'Störgröße für Heizung und Verbrauch',
        }],
        place: { name: 'Teststandort', latitude: 52.5, longitude: 13.4 },
        attribution: 'Testquelle, frei.',
        minRequestIntervalMs: 0,
        cacheTtlMs: 60_000,
    };
}

async function registerWeather(
    handle: ReturnType<typeof newHandle>,
    id = 'wetter',
    mapping: RestSourceMapping = weatherMapping(),
) {
    const impl = getConnectorKind('rest-timeseries');
    if (!impl) throw new Error('rest-timeseries fehlt im Katalog');
    const locator = impl.locatorFor(impl.parseConfig({ preset: 'custom', mapping: JSON.stringify(mapping) }));
    await createConnector(handle, { id, name: 'Wetter', kind: 'rest-timeseries', locator });
}

async function dump(store: OxigraphStore, graphIri: string): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const quad of store.dump(namedNode(graphIri))) quads.push(quad);
    return quads;
}

describe('Der Connector materialisiert die Struktur — und nie einen Messwert (Invariante C3)', () => {
    /** Ein wiedererkennbarer Messwert — er darf nirgends im Graphen auftauchen. */
    const MEASURED = 12.5;
    const constantWeather = () => MEASURED;

    it('importiert Quelle, Ort und Reihe als SOSA — ohne eine einzige Zahl aus der Antwort', async () => {
        const handle = newHandle();
        const { fetchImpl } = weatherRoutes(constantWeather);
        await registerWeather(handle);

        const result = await syncConnector(handle, 'wetter', { fetchImpl });
        expect(result.status).toBe('imported');

        const quads = await dump(handle.store, handle.iri.importGraph('wetter'));
        const sensor = handle.iri.entity('sensor', restSourceKey('wetter', 'temperature'));
        const own = quads.filter(quad => quad.subject.value === sensor);
        expect(own.some(quad => quad.object.value === SOSA.Sensor)).toBe(true);
        expect(own.find(quad => quad.predicate.value === DCTERMS.identifier)?.object.value)
            .toBe('wetter#temperature');
        expect(own.find(quad => quad.predicate.value === OW.observationKind)?.object.value).toBe('numeric');
        expect(own.find(quad => quad.predicate.value === SCHEMA.unitText)?.object.value).toBe('°C');
        expect(quads.some(quad => quad.predicate.value === SCHEMA.creditText)).toBe(true);
        expect(quads.some(quad => quad.predicate.value === SCHEMA.latitude)).toBe(true);

        // DER Nachweis: keiner der importierten Werte ist ein Messwert.
        expect(quads.some(quad => quad.object.value === String(MEASURED))).toBe(false);
        // Auch kein Beobachtungs-Vokabular: Es gibt keine sosa:Observation,
        // weil es keinen Messwert gibt, den sie tragen könnte.
        expect(quads.some(quad => quad.object.value.startsWith('http://www.w3.org/ns/sosa/Observation'))).toBe(false);
    });

    it('hält die Revision an der Struktur fest, nicht am Messwert', async () => {
        const handle = newHandle();
        await registerWeather(handle);
        const first = await syncConnector(handle, 'wetter', { fetchImpl: weatherRoutes(constantWeather).fetchImpl });
        resetRestTimeseriesCache();
        // Andere Zahlen, dieselbe Struktur → No-Op.
        const second = await syncConnector(handle, 'wetter', { fetchImpl: weatherRoutes(() => 99.9).fetchImpl });
        expect(second.status).toBe('noop');
        expect(second.revision).toBe(first.revision);
    });

    it('quarantäniert eine beschriebene, aber nicht gelieferte Größe statt abzubrechen', async () => {
        const handle = newHandle();
        const mapping = weatherMapping();
        mapping.series.push({
            key: 'ozon', name: 'Ozon', kind: 'numeric', aggregation: 'mean', field: 'ozone',
        });
        await registerWeather(handle, 'wetter', mapping);

        const result = await syncConnector(handle, 'wetter', { fetchImpl: weatherRoutes(constantWeather).fetchImpl });
        expect(result.status).toBe('imported');
        expect(result.quarantined.map(entry => entry.reason).join(' ')).toContain('ozone');
        const quads = await dump(handle.store, handle.iri.importGraph('wetter'));
        expect(quads.some(quad => quad.object.value === 'wetter#ozon')).toBe(false);
    });

    it('holt eine Antwort einmal und bedient daraus alle Reihen der Quelle', async () => {
        const handle = newHandle();
        const mapping = weatherMapping();
        mapping.series.push({
            key: 'wind', name: 'Wind', kind: 'numeric', aggregation: 'mean', field: 'wind',
        });
        const { fetchImpl, log } = weatherRoutes(constantWeather, () => ({ wind: 3 }));
        await registerWeather(handle, 'wetter', mapping);
        await syncConnector(handle, 'wetter', { fetchImpl });
        const afterSync = log.length;
        // probe und pull fragen dasselbe Fenster — die zweite Anfrage kommt
        // aus dem Zwischenspeicher.
        expect(afterSync).toBe(1);
    });
});

// --- Erfassung über die offene Quelle ------------------------------------

describe('Erfassung: die Werte liegen daneben, nicht im Store', () => {
    const START = Date.parse('2026-06-01T00:00:00.000Z');
    const NOW = START + 48 * HOUR;
    /**
     * Ein Tagesgang, damit die Reihe nicht konstant ist — mit Nachkommastelle,
     * damit kein Messwert zufällig wie eine Strukturzahl aussieht.
     */
    const valueAt = (t: number) => 10.5 + ((t - START) / HOUR) % 12;

    async function prepared() {
        const handle = newHandle();
        const files = createMemoryFileSystem();
        const { fetchImpl, log } = weatherRoutes(valueAt);
        await registerWeather(handle);
        await syncConnector(handle, 'wetter', { fetchImpl });
        return { handle, files, fetchImpl, log };
    }

    it('führt die offene Reihe in derselben Kandidatenliste wie das Haus — mit ihrer Quellart', async () => {
        const { handle } = await prepared();
        const candidates = await listCaptureCandidates(handle.store, handle.iri);
        const candidate = candidates.find(entry => entry.source === 'wetter#temperature');
        expect(candidate?.sourceKind).toBe('rest-timeseries');
        expect(candidate?.connectorId).toBe('wetter');
        expect(candidate?.actuator).toBe(false);
        expect(candidate?.note).toContain('Störgröße');
        expect(candidate?.placeName).toBe('Teststandort');
    });

    it('erfasst Werte als NDJSON, hält das Wasserzeichen und lässt den Graphen zahlenfrei', async () => {
        const { handle, files, fetchImpl } = await prepared();
        await createVariable(handle, {
            id: variableIdFor('wetter#temperature'),
            name: 'Außentemperatur',
            sourceKind: 'rest-timeseries',
            source: 'wetter#temperature',
            kind: 'numeric',
            aggregation: 'mean',
            intervalSeconds: 3600,
            unit: '°C',
        });

        const first = await captureObservations(handle, {
            files, root: ROOT, fetchImpl, backfillDays: 3, now: () => new Date(NOW),
        });
        expect(first.results[0].status).toBe('captured');
        expect(first.results[0].appended).toBeGreaterThan(40);

        const observations = new ObservationStore({ files, root: ROOT, userId: 'default' });
        const read = await observations.read('wetter-temperature');
        expect(read.observations.length).toBeGreaterThan(40);
        expect(read.observations.every(point => point.v === null || typeof point.v === 'number')).toBe(true);

        // Zweiter Lauf: keine Dublette (Wasserzeichen).
        const second = await captureObservations(handle, {
            files, root: ROOT, fetchImpl, backfillDays: 3, now: () => new Date(NOW),
        });
        expect(second.results[0].appended).toBe(0);
        expect((await observations.read('wetter-temperature')).observations.length).toBe(read.observations.length);

        // Und im Graphen steht die Regel, nicht der Wert (Invariante C3).
        const meta = await dump(handle.store, handle.iri.sharedGraph('meta'));
        const measured = new Set(read.observations.map(point => String(point.v)));
        const variableQuads = meta.filter(quad =>
            quad.subject.value === handle.iri.entity('variable', 'wetter-temperature'));
        expect(variableQuads.some(quad => measured.has(quad.object.value))).toBe(false);
        expect(variableQuads.some(quad => quad.predicate.value === OW.capturedThrough)).toBe(true);
    });

    it('lässt die offene Reihe laufen, wenn der Home-Assistant-Zugang fehlt', async () => {
        const { handle, files, fetchImpl } = await prepared();
        await createVariable(handle, {
            id: 'wetter-temperature', name: 'Außentemperatur', sourceKind: 'rest-timeseries',
            source: 'wetter#temperature', kind: 'numeric', aggregation: 'mean', intervalSeconds: 3600,
        });
        await createVariable(handle, {
            id: 'heizung', name: 'Heizung', sourceKind: 'home-assistant',
            source: 'switch.heizung', kind: 'binary', aggregation: 'last', intervalSeconds: 3600,
        });

        const report = await captureObservations(handle, {
            files, root: ROOT, fetchImpl, backfillDays: 3, now: () => new Date(NOW),
        });
        const byId = new Map(report.results.map(result => [result.variableId, result]));
        expect(byId.get('heizung')?.status).toBe('failed');
        expect(byId.get('heizung')?.message).toContain('Home-Assistant-Verbindung');
        expect(byId.get('wetter-temperature')?.status).toBe('captured');
    });

    it('meldet eine unerreichbare Quelle, statt eine leere Reihe zu behaupten', async () => {
        const { handle, files } = await prepared();
        await createVariable(handle, {
            id: 'wetter-temperature', name: 'Außentemperatur', sourceKind: 'rest-timeseries',
            source: 'wetter#temperature', kind: 'numeric', aggregation: 'mean', intervalSeconds: 3600,
        });
        const broken = (async () => new Response('kaputt', { status: 503, statusText: 'Service Unavailable' })
        ) as unknown as typeof fetch;

        const report = await captureObservations(handle, {
            files, root: ROOT, fetchImpl: broken, backfillDays: 1, now: () => new Date(NOW),
        });
        expect(report.results[0].status).toBe('failed');
        expect(report.results[0].message).toContain('503');
        const observations = new ObservationStore({ files, root: ROOT, userId: 'default' });
        expect((await observations.read('wetter-temperature')).observations).toEqual([]);
    });
});

// --- Gerechnete Reihen: der Sonnenstand ----------------------------------

describe('Sonnenstand: eine berechnete Größe IST eine Beobachtung', () => {
    it('trifft die bekannten Werte — Sonnenwende, Tagundnachtgleiche, Äquator', () => {
        const berlin = { lat: 52.52, lon: 13.405 };
        // Sommersonnenwende, wahrer Mittag in Berlin: 90° − Breite +
        // Deklination = 60,9°. Die Zahl steht in jedem Tafelwerk.
        const summer = solarPosition(Date.parse('2026-06-21T11:07:00Z'), berlin.lat, berlin.lon);
        expect(summer.elevation).toBeCloseTo(60.9, 0);
        expect(summer.declination).toBeCloseTo(23.44, 1);
        // Wahrer Mittag heißt: die Sonne steht im Süden.
        expect(summer.azimuth).toBeGreaterThan(175);
        expect(summer.azimuth).toBeLessThan(185);

        // Wintersonnenwende: 90° − Breite − Deklination = 14,0°.
        const winter = solarPosition(Date.parse('2026-12-21T11:12:00Z'), berlin.lat, berlin.lon);
        expect(winter.elevation).toBeCloseTo(14.0, 0);
        expect(winter.declination).toBeCloseTo(-23.44, 1);

        // Tagundnachtgleiche: Deklination null.
        const equinox = solarPosition(Date.parse('2026-03-20T11:10:00Z'), berlin.lat, berlin.lon);
        expect(Math.abs(equinox.declination)).toBeLessThan(0.5);
        expect(equinox.elevation).toBeCloseTo(37.4, 0);

        // Am Äquator zur Tagundnachtgleiche steht die Sonne mittags fast
        // im Zenit — die Probe darauf, dass die Breitenrechnung stimmt.
        expect(solarPosition(Date.parse('2026-03-20T12:00:00Z'), 0, 0).elevation).toBeGreaterThan(87);
    });

    it('meldet die Nacht als Nacht statt als kleine Zahl', () => {
        const night = solarPosition(Date.parse('2026-06-21T00:00:00Z'), 52.52, 13.405);
        expect(night.elevation).toBeLessThan(0);
        // Unter dem Horizont gibt es keine Einstrahlung — auch keine
        // winzige. Ein Rest wäre eine Erfindung.
        expect(night.extraterrestrialIrradiance).toBe(0);
    });

    it('läuft ohne Netz, hält den Locator und behauptet keine Erreichbarkeit', async () => {
        const config = { latitude: '52.52', longitude: '13.405', placeName: 'Zuhause' };
        expect(solarPositionConnector.configFromLocator(solarPositionConnector.locatorFor(config)))
            .toEqual(config);
        expect(() => solarPositionConnector.parseConfig({ latitude: '95', longitude: '0' }))
            .toThrow(/Breitengrad/);

        const handle = newHandle();
        const impl = getConnectorKind('solar-position');
        expect(impl).not.toBeNull();
        if (!impl) return;
        await createConnector(handle, {
            id: 'sonne', name: 'Sonnenstand', kind: 'solar-position',
            locator: impl.locatorFor(impl.parseConfig(config)),
        });
        // Kein fetch-Stub: Diese Quelle darf gar nicht ins Netz greifen.
        const first = await syncConnector(handle, 'sonne', {});
        expect(first.status).toBe('imported');
        const second = await syncConnector(handle, 'sonne', {});
        expect(second.status).toBe('noop');
        expect(second.revision).toBe(first.revision);
    });

    it('schreibt das Verfahren in den Graphen, damit gerechnet nie wie gemessen aussieht', async () => {
        const handle = newHandle();
        const impl = getConnectorKind('solar-position');
        if (!impl) return;
        await createConnector(handle, {
            id: 'sonne', name: 'Sonnenstand', kind: 'solar-position',
            locator: impl.locatorFor(impl.parseConfig({ latitude: '52.52', longitude: '13.405' })),
        });
        await syncConnector(handle, 'sonne', {});

        const quads = await dump(handle.store, handle.iri.importGraph('sonne'));
        const procedureIri = handle.iri.entity('procedure', SOLAR_PROCEDURE_ID);
        expect(quads.some(quad =>
            quad.subject.value === procedureIri && quad.object.value === SOSA.Procedure)).toBe(true);
        const sensor = handle.iri.entity('sensor', 'sonne#elevation');
        expect(quads.some(quad =>
            quad.subject.value === sensor
            && quad.predicate.value === SSN.implements
            && quad.object.value === procedureIri)).toBe(true);

        // Und sie steht in derselben Kandidatenliste wie alles andere.
        const candidates = await listCaptureCandidates(handle.store, handle.iri);
        const candidate = candidates.find(entry => entry.source === 'sonne#elevation');
        expect(candidate?.sourceKind).toBe('solar-position');
        expect(candidate?.kind).toBe('numeric');
        expect(candidates.find(entry => entry.source === 'sonne#daylight')?.kind).toBe('binary');
    });

    it('erfasst gerechnete Werte auf dem Raster der Größe — lückenlos', async () => {
        const handle = newHandle();
        const files = createMemoryFileSystem();
        const impl = getConnectorKind('solar-position');
        if (!impl) return;
        await createConnector(handle, {
            id: 'sonne', name: 'Sonnenstand', kind: 'solar-position',
            locator: impl.locatorFor(impl.parseConfig({ latitude: '52.52', longitude: '13.405' })),
        });
        await syncConnector(handle, 'sonne', {});
        for (const [key, kind] of [['elevation', 'numeric'], ['daylight', 'binary']] as const) {
            await createVariable(handle, {
                id: variableIdFor(`sonne#${key}`),
                name: key,
                sourceKind: 'solar-position',
                source: `sonne#${key}`,
                kind,
                aggregation: kind === 'numeric' ? 'mean' : 'last',
                intervalSeconds: 3600,
            });
        }

        const now = Date.parse('2026-06-22T00:00:00.000Z');
        const report = await captureObservations(handle, {
            files, root: ROOT, backfillDays: 1, now: () => new Date(now),
        });
        expect(report.results.every(result => result.status === 'captured')).toBe(true);

        const observations = new ObservationStore({ files, root: ROOT, userId: 'default' });
        const elevation = await observations.read('sonne-elevation');
        // 24 Stunden, stündlich, ohne eine einzige Lücke: Das ist der
        // Gewinn einer gerechneten Reihe.
        expect(elevation.observations.length).toBeGreaterThanOrEqual(24);
        expect(elevation.observations.some(point => point.v === null)).toBe(false);

        const daylight = await observations.read('sonne-daylight');
        const values = new Set(daylight.observations.map(point => point.v));
        expect(values.has(0)).toBe(true);
        expect(values.has(1)).toBe(true);
    });
});

// --- Eigene Messreihen aus einer Datei -----------------------------------

describe('csv-observations: der Datei- statt des Netz-Wegs', () => {
    const CSV = [
        'timestamp,gewicht,stimmung,geheizt',
        '2026-06-01T00:00:00Z,81.4,gut,1',
        '2026-06-02T00:00:00Z,81.1,mittel,0',
        '2026-06-03T00:00:00Z,80.9,gut,1',
    ].join('\n');

    const CSV_PATH = 'data/vaults/messungen/tagebuch.csv';

    function csvFiles(content = CSV) {
        const files = createMemoryFileSystem();
        return { files, content };
    }

    async function withCsv(content = CSV) {
        const handle = newHandle();
        const { files } = csvFiles();
        await files.mkdir(`${process.cwd()}/data/vaults/messungen`);
        await files.writeFile(`${process.cwd()}/${CSV_PATH}`, content);
        const impl = getConnectorKind('csv-observations');
        if (!impl) throw new Error('csv-observations fehlt');
        await createConnector(handle, {
            id: 'tagebuch',
            name: 'Tagebuch',
            kind: 'csv-observations',
            locator: impl.locatorFor(impl.parseConfig({ path: CSV_PATH })),
        });
        return { handle, files };
    }

    it('erkennt das Skalenniveau am Bestand, nicht am Spaltennamen', () => {
        expect(classifyColumn(['81.4', '80.9'])).toBe('numeric');
        expect(classifyColumn(['1', '0', '1'])).toBe('binary');
        expect(classifyColumn(['gut', 'mittel'])).toBe('categorical');
        // Eine leere Spalte ist nicht numerisch — sie ist unbekannt, und
        // die vorsichtigste Einstufung ist kategorial.
        expect(classifyColumn(['', ' '])).toBe('categorical');
    });

    it('liest die Kopfzeile als Wahrheit und meldet eine fehlende Zeitspalte', () => {
        const inventory = inventoryFromCsv(
            { path: CSV_PATH, timeField: 'timestamp', timeFormat: 'iso', delimiter: ',' },
            CSV,
        );
        expect(inventory.mapping.series.map(entry => entry.key)).toEqual(['gewicht', 'stimmung', 'geheizt']);
        expect(inventory.mapping.series.map(entry => entry.kind)).toEqual(['numeric', 'categorical', 'binary']);
        expect(() => inventoryFromCsv(
            { path: CSV_PATH, timeField: 'zeit', timeFormat: 'iso', delimiter: ',' },
            CSV,
        )).toThrow(/Zeitspalte/);
    });

    it('importiert die Spalten als Struktur und die Datei als Herkunft', async () => {
        const { handle, files } = await withCsv();
        const result = await syncConnector(handle, 'tagebuch', { files });
        expect(result.status).toBe('imported');

        const quads = await dump(handle.store, handle.iri.importGraph('tagebuch'));
        const sensor = handle.iri.entity('sensor', 'tagebuch#gewicht');
        expect(quads.some(quad => quad.subject.value === sensor && quad.object.value === SOSA.Sensor)).toBe(true);
        // Ein Dateipfad ist keine URL — er steht unter dcterms:source.
        expect(quads.some(quad => quad.predicate.value === DCTERMS.source && quad.object.value === CSV_PATH))
            .toBe(true);
        expect(quads.some(quad => quad.predicate.value === SCHEMA.url)).toBe(false);
        // Und kein Messwert im Store (Invariante C3).
        expect(quads.some(quad => quad.object.value === '81.4')).toBe(false);
    });

    it('erfasst die Werte aus der Datei und liest sie nur einmal', async () => {
        const { handle, files } = await withCsv();
        await syncConnector(handle, 'tagebuch', { files });
        for (const [key, kind] of [['gewicht', 'numeric'], ['geheizt', 'binary']] as const) {
            await createVariable(handle, {
                id: variableIdFor(`tagebuch#${key}`),
                name: key,
                sourceKind: 'csv-observations',
                source: `tagebuch#${key}`,
                kind,
                aggregation: kind === 'numeric' ? 'mean' : 'last',
                intervalSeconds: 86_400,
            });
        }
        const report = await captureObservations(handle, {
            files, root: ROOT, backfillDays: 10,
            now: () => new Date(Date.parse('2026-06-04T00:00:00.000Z')),
        });
        expect(report.results.every(result => result.status === 'captured')).toBe(true);

        const observations = new ObservationStore({ files, root: ROOT, userId: 'default' });
        const weight = await observations.read('tagebuch-gewicht');
        expect(weight.observations.map(point => point.v)).toContain(81.4);
        expect((await observations.read('tagebuch-geheizt')).observations.some(point => point.v === 0)).toBe(true);
    });

    it('lehnt einen Pfad außerhalb der erlaubten Wurzeln ab', async () => {
        const impl = getConnectorKind('csv-observations');
        if (!impl) return;
        const handle = newHandle();
        const { files } = csvFiles();
        await createConnector(handle, {
            id: 'boese', name: 'Böse', kind: 'csv-observations',
            locator: impl.locatorFor(impl.parseConfig({ path: '/etc/passwd' })),
        });
        const result = await syncConnector(handle, 'boese', { files });
        expect(result.status).toBe('failed');
        expect(result.message).toContain('blockiert');
    });

    it('folgt der Datei: geänderter Inhalt ist eine neue Revision', async () => {
        const { handle, files } = await withCsv();
        const first = await syncConnector(handle, 'tagebuch', { files });
        await files.writeFile(`${process.cwd()}/${CSV_PATH}`, `${CSV}\n2026-06-04T00:00:00Z,80.5,gut,0`);
        const second = await syncConnector(handle, 'tagebuch', { files });
        expect(second.status).toBe('imported');
        expect(second.revision).not.toBe(first.revision);
    });
});

// --- Die Abnahme ---------------------------------------------------------

/**
 * Die Wahrheit, von Hand gesetzt: Draußen ist es kalt oder warm (Z).
 * Kälte macht Heizen wahrscheinlicher (Z → T) UND drückt die
 * Innentemperatur (Z → Y). Heizen hebt sie um genau 2 °C (T → Y).
 *
 * Wer Z ignoriert, misst deshalb Unsinn: Geheizt wird, wenn es kalt ist,
 * und kalt heißt niedrige Innentemperatur — der rohe Zusammenhang lässt
 * Heizen wirkungslos oder gar schädlich aussehen. Genau diese Umkehrung
 * ist der Grund, warum C5 überhaupt gebaut wird.
 */
function heatingWorld(rows: number, seed = 11) {
    const random = createRandom(seed);
    const outdoor: number[] = [];
    const heating: number[] = [];
    const indoor: number[] = [];
    for (let index = 0; index < rows; index += 1) {
        const z = 10 + 6 * normalDraw(random);
        const t = 1 / (1 + Math.exp((z - 10) / 3)) > random() ? 1 : 0;
        const y = 20 + 2 * t + 0.5 * (z - 10) + 0.4 * normalDraw(random);
        outdoor.push(z);
        heating.push(t);
        indoor.push(y);
    }
    return { outdoor, heating, indoor, effect: 2 };
}

describe('Abnahme C5: dieselbe Frage mit und ohne Adjustierung (§16)', () => {
    const START = Date.parse('2026-06-01T00:00:00.000Z');
    const ROWS = 480;
    const NOW = START + ROWS * HOUR;
    const world = heatingWorld(ROWS);
    /**
     * Die Quelle kennt die Außentemperatur für den Studienzeitraum; davor
     * und danach liefert sie einen unauffälligen Wert — eine echte Quelle
     * antwortet schließlich auch auf das Probe-Fenster von heute.
     */
    const weatherAt = (t: number): number => {
        const index = Math.round((t - START) / HOUR);
        return index >= 0 && index < ROWS ? world.outdoor[index] : 10;
    };

    const outdoorId = variableIdFor('wetter#temperature');
    const variableIri = (id: string) => createIriFactory(INSTANCE_BASE).entity('variable', id);

    function seriesOf(values: readonly number[]): Observation[] {
        return values.map((value, index) => ({ t: START + index * HOUR, v: value }));
    }

    async function buildHouse() {
        const handle = newHandle();
        const files = createMemoryFileSystem();
        const observations = new ObservationStore({ files, root: ROOT, userId: 'default' });

        // Behandlung und Wirkung kommen aus dem Haus — ihre Reihen liegen
        // im Beobachtungs-Speicher, wie es C3 vorsieht.
        for (const [id, name, kind, values] of [
            ['heizung', 'Heizung', 'binary', world.heating],
            ['innentemperatur', 'Innentemperatur', 'numeric', world.indoor],
        ] as const) {
            await createVariable(handle, {
                id, name, sourceKind: 'home-assistant', source: `sensor.${id}`,
                kind, aggregation: kind === 'binary' ? 'last' : 'mean', intervalSeconds: 3600,
                ...(kind === 'numeric' ? { unit: '°C' } : {}),
            });
            await observations.append(id, seriesOf(values));
        }

        await createCausalModel(handle, { id: 'wohnung', name: 'Wohnung' });
        for (const [id, name] of [
            ['heizung', 'Heizung'],
            ['innentemperatur', 'Innentemperatur'],
            [outdoorId, 'Außentemperatur'],
        ] as const) {
            await applyStructureOperation(handle, 'wohnung', {
                op: 'add-variable', iri: variableIri(id), name,
            });
        }
        for (const [from, to] of [
            [outdoorId, 'heizung'],
            [outdoorId, 'innentemperatur'],
            ['heizung', 'innentemperatur'],
        ] as const) {
            await applyStructureOperation(handle, 'wohnung', {
                op: 'add-edge', from: variableIri(from), to: variableIri(to), edgeClass: 'asserted',
            });
        }
        await createEstimand(handle, {
            id: 'heizen-auf-innentemperatur',
            name: 'Wirkung des Heizens auf die Innentemperatur',
            modelId: 'wohnung',
            treatment: variableIri('heizung'),
            outcome: variableIri('innentemperatur'),
            estimator: 'regression',
            seed: 42,
        });
        return { handle, files, observations };
    }

    async function runStudies(
        handle: ReturnType<typeof newHandle>,
        observations: ObservationStore,
    ) {
        const metadata: VariableMetadata[] = (await listVariables(handle)).map(view => ({
            iri: view.iri,
            id: view.id,
            name: view.name,
            kind: view.kind,
            aggregation: view.aggregation,
            intervalSeconds: view.intervalSeconds,
            ...(view.unit ? { unit: view.unit } : {}),
        }));
        return runCausalStudies(handle, metadata, {
            now: new Date('2026-08-14T10:00:00.000Z'),
            softwareVersion: '0.1.0-test',
            bootstrapSamples: 60,
            readSeries: async (variableId, range) => (await observations.read(variableId, range)).observations,
        });
    }

    it('ohne die offene Quelle endet die Frage bei „nicht identifizierbar" — mit Namen', async () => {
        const { handle, observations } = await buildHouse();
        const summary = await runStudies(handle, observations);
        expect(summary.results).toHaveLength(1);
        const result = summary.results[0];
        expect(result.verdict).toBe('not-identifiable');
        expect(result.reason).toContain('Außentemperatur');
        expect(result.effect).toBeUndefined();
        expect(result.contrast).toBeUndefined();
    });

    it('mit der Störgröße aus Open Data steht die Zahl da — und daneben die ohne sie', async () => {
        const { handle, files, observations } = await buildHouse();

        // 1. Quelle einbinden und ihre Struktur importieren.
        const { fetchImpl } = weatherRoutes(weatherAt);
        await registerWeather(handle);
        expect((await syncConnector(handle, 'wetter', { fetchImpl })).status).toBe('imported');

        // 2. Die Störgröße aus der Kandidatenliste aufnehmen — derselbe Weg,
        //    den die Route geht.
        const candidate = (await listCaptureCandidates(handle.store, handle.iri))
            .find(entry => entry.source === 'wetter#temperature');
        expect(candidate).toBeDefined();
        if (!candidate) return;
        await createVariable(handle, {
            id: variableIdFor(candidate.source),
            name: 'Außentemperatur',
            sourceKind: candidate.sourceKind,
            source: candidate.source,
            kind: candidate.kind,
            aggregation: 'mean',
            intervalSeconds: 3600,
            ...(candidate.unit ? { unit: candidate.unit } : {}),
            sensorIri: candidate.iri,
        });

        // 3. Werte holen.
        const capture = await captureObservations(handle, {
            files, root: ROOT, fetchImpl, backfillDays: 25, now: () => new Date(NOW),
        });
        expect(capture.results.find(entry => entry.variableId === outdoorId)?.status).toBe('captured');

        // 4. Dieselbe Frage noch einmal.
        const summary = await runStudies(handle, observations);
        const result = summary.results[0];
        expect(summary.rejected).toEqual([]);
        expect(result.verdict).toBe('passed');
        expect(result.adjustedFor).toEqual([variableIri(outdoorId)]);

        // Die gesetzte Wahrheit wird wiedergefunden …
        expect(result.effect?.effect).toBeGreaterThan(1.6);
        expect(result.effect?.effect).toBeLessThan(2.4);

        // … und der Kontrast zeigt, was die Störgröße ausgemacht hat.
        const contrast = result.contrast;
        expect(contrast).toBeDefined();
        if (!contrast) return;
        expect(contrast.crude).toBeDefined();
        // Ohne Adjustierung sieht Heizen wirkungslos oder schädlich aus:
        // Geheizt wird, wenn es kalt ist.
        expect(contrast.crude as number).toBeLessThan(1);
        expect(Math.abs(contrast.shift as number)).toBeGreaterThan(1);
        expect(contrast.outsideInterval).toBe(true);
        expect(contrast.adjustedFor).toEqual([variableIri(outdoorId)]);
        expect(contrast.explanation).toContain('Ohne Adjustierung');
        expect(contrast.explanation).toContain('Außentemperatur');
        expect(contrast.explanation).toContain('Zusammenhang, keine Wirkung');

        // Der Kontrast steht auch im Graphen — mit eigenen Termen, damit der
        // rohe Wert nie wie ein Effekt aussieht (Invariante C5).
        const quads = await dump(handle.store, causalInferredGraph(handle.iri, 'workspace'));
        const contrastNode = quads.find(quad => quad.object.value === OW.ConfoundingContrast)?.subject.value;
        expect(contrastNode).toBeDefined();
        const own = quads.filter(quad => quad.subject.value === contrastNode);
        expect(own.some(quad => quad.predicate.value === OW.crudeAssociation)).toBe(true);
        expect(own.some(quad => quad.predicate.value === OW.crudeCiLow)).toBe(true);
        expect(own.some(quad => quad.predicate.value === OW.confoundingShift)).toBe(true);
        expect(own.some(quad => quad.predicate.value === OW.effectSize)).toBe(false);
        expect(own.some(quad => quad.predicate.value === OW.refutationPassed)).toBe(false);

        // Und das Lesemodell trägt ihn mit — die UI erfindet nichts.
        const studies = await readCausalStudies(handle);
        expect(studies[0].contrast?.crude).toBeCloseTo(contrast.crude as number, 6);
        expect(studies[0].contrast?.adjustedFor).toEqual([variableIri(outdoorId)]);
        expect(studies[0].effect?.value).toBeCloseTo(result.effect?.effect as number, 6);
    });
});
