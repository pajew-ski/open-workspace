// @vitest-environment node
/**
 * Abnahme der Beobachtungs-Erfassung (CAUSAL_LAYER_SPEC §5/§6).
 *
 * Geprüft wird genau das, worauf später jede kausale Aussage steht:
 *
 *  1. **Idempotenz.** Zwei Läufe über dasselbe Fenster erzeugen keine
 *     Dublette — das Wasserzeichen hält.
 *  2. **Kein Wert im Store.** Nach der Erfassung steht im Graphen die
 *     Erfassungsregel und die Abdeckung, aber KEIN Messwert
 *     (Invariante C3).
 *  3. **Lücken bleiben Lücken.** `unavailable` wird als Lücke erfasst,
 *     nicht als letzter Wert fortgeschrieben.
 *  4. **Zustände halten an.** Ein Schalter ohne neuen Eintrag bleibt im
 *     Raster auf seinem Wert.
 *  5. **Verdichtung ist geprüft.** Ein Mittelwert über kategoriale
 *     Zustände wird abgelehnt, nicht stillschweigend korrigiert.
 *  6. **Backfill greift zurück.** Der erste Lauf holt die Vergangenheit,
 *     der zweite nur den Zuwachs.
 *  7. **Aufbewahrung räumt auf**, ohne den laufenden Tag anzufassen.
 *  8. **Kaputte Zeilen** machen keine Jahresreihe unlesbar.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@/lib/graph/store/oxigraph';
import { createIriFactory } from '@/lib/graph/iri';
import { namedNode } from '@/lib/graph/rdf';
import { OW, RDF } from '@/lib/graph/vocab';
import { createMemoryFileSystem } from '@/lib/platform/runtime/memfs';
import { ObservationStore } from '@/lib/graph/observations/store';
import { resample } from '@/lib/graph/observations/resample';
import {
    createVariable,
    getVariable,
    listVariables,
    updateVariable,
    durationToSeconds,
    secondsToDuration,
} from '@/lib/graph/observations/variables';
import { captureObservations } from '@/lib/graph/observations/capture';
import { parseState, classifyEntity, variableIdFor } from '@/lib/graph/connectors/home-assistant/structure';
import type { HomeAssistantClient, HaHistoryPoint } from '@/lib/graph/connectors/home-assistant/api';

const INSTANCE_BASE = 'urn:ow:11111111-2222-4333-8444-555555555555:';
const ROOT = '/data';

/** Minute in Millisekunden — die Tests rechnen in Minuten, das liest sich. */
const MIN = 60_000;
/** Fester „Jetzt"-Zeitpunkt: 2026-08-13T12:00:00Z. */
const NOW = Date.parse('2026-08-13T12:00:00.000Z');

function newHandle() {
    return { store: new OxigraphStore(), iri: createIriFactory(INSTANCE_BASE) };
}

/**
 * Client-Double: liefert vorgegebene Punkte im angefragten Fenster und
 * merkt sich, welche Fenster abgefragt wurden. Damit ist prüfbar, dass
 * der zweite Lauf NICHT dieselbe Vergangenheit noch einmal holt.
 */
function fakeClient(points: HaHistoryPoint[]) {
    const windows: Array<{ from: string; to: string }> = [];
    const client = {
        async history(entityIds: ReadonlyArray<string>, startIso: string, endIso: string) {
            windows.push({ from: startIso, to: endIso });
            const from = Date.parse(startIso);
            const to = Date.parse(endIso);
            return points.filter(p => entityIds.includes(p.entityId) && p.t >= from && p.t <= to);
        },
    } as unknown as HomeAssistantClient;
    return { client, windows };
}

async function addVariable(handle: ReturnType<typeof newHandle>, overrides: Partial<{
    id: string; source: string; kind: 'numeric' | 'binary' | 'categorical';
    aggregation: 'last' | 'mean' | 'min' | 'max' | 'sum'; intervalSeconds: number; retentionDays: number;
}> = {}) {
    return createVariable(handle, {
        id: overrides.id ?? 'sensor-wohnzimmer-temperatur',
        name: 'Wohnzimmer Temperatur',
        sourceKind: 'home-assistant',
        source: overrides.source ?? 'sensor.wohnzimmer_temperatur',
        kind: overrides.kind ?? 'numeric',
        aggregation: overrides.aggregation ?? 'mean',
        intervalSeconds: overrides.intervalSeconds ?? 300,
        retentionDays: overrides.retentionDays ?? 0,
    });
}

describe('Beobachtungs-Speicher', () => {
    let files: ReturnType<typeof createMemoryFileSystem>;
    let store: ObservationStore;

    beforeEach(() => {
        files = createMemoryFileSystem();
        store = new ObservationStore({ files, root: ROOT, userId: 'default' });
    });

    it('hängt an und liest aufsteigend zurück', async () => {
        const result = await store.append('v1', [
            { t: NOW, v: 21.5 },
            { t: NOW + MIN, v: 21.6 },
        ]);
        expect(result.appended).toBe(2);

        const read = await store.read('v1');
        expect(read.observations.map(o => o.v)).toEqual([21.5, 21.6]);
        expect(read.corruptLines).toBe(0);
    });

    it('verwirft alles bis zum Wasserzeichen — ein zweiter Lauf erzeugt keine Dublette', async () => {
        await store.append('v1', [{ t: NOW, v: 1 }, { t: NOW + MIN, v: 2 }]);
        const again = await store.append('v1', [
            { t: NOW, v: 1 },
            { t: NOW + MIN, v: 2 },
            { t: NOW + 2 * MIN, v: 3 },
        ], { after: NOW + MIN });

        expect(again.appended).toBe(1);
        expect((await store.read('v1')).observations).toHaveLength(3);
    });

    it('teilt nach UTC-Tagen und findet über die Tagesgrenze hinweg', async () => {
        const beforeMidnight = Date.parse('2026-08-13T23:58:00.000Z');
        await store.append('v1', [
            { t: beforeMidnight, v: 1 },
            { t: beforeMidnight + 4 * MIN, v: 2 },
        ]);
        expect((await store.segments('v1')).map(s => s.day)).toEqual(['2026-08-13', '2026-08-14']);
        expect((await store.read('v1')).observations).toHaveLength(2);
    });

    it('überspringt kaputte Zeilen und meldet sie, statt die Reihe zu verlieren', async () => {
        await store.append('v1', [{ t: NOW, v: 1 }]);
        const [segment] = await store.segments('v1');
        await files.writeFile(segment.path, `${await files.readFile(segment.path)}{kaputt\n{"t":${NOW + MIN},"v":2}\n`);

        const read = await store.read('v1');
        expect(read.observations.map(o => o.v)).toEqual([1, 2]);
        expect(read.corruptLines).toBe(1);
    });

    it('räumt nach Aufbewahrungsfrist nur ganze, abgelaufene Tage weg', async () => {
        const oldDay = Date.parse('2026-08-01T10:00:00.000Z');
        await store.append('v1', [{ t: oldDay, v: 1 }, { t: NOW, v: 2 }]);

        const pruned = await store.prune('v1', NOW);
        expect(pruned.pruned).toBe(1);
        expect(pruned.removedSegments).toEqual(['2026-08-01']);
        // Der laufende Tag bleibt vollständig erhalten.
        expect((await store.read('v1')).observations.map(o => o.v)).toEqual([2]);
    });

    it('meldet die Abdeckung aus dem Bestand, nicht aus einem Zähler', async () => {
        await store.append('v1', [{ t: NOW, v: 1 }, { t: NOW + 10 * MIN, v: 2 }]);
        const coverage = await store.coverage('v1');
        expect(coverage).toEqual({ from: NOW, through: NOW + 10 * MIN, count: 2 });
    });
});

describe('Verdichtung', () => {
    it('mittelt numerische Werte auf das Raster', () => {
        const points = resample(
            [
                { t: NOW + 30_000, value: 20 },
                { t: NOW + 60_000, value: 22 },
                { t: NOW + 5 * MIN + 10_000, value: 30 },
            ],
            { intervalSeconds: 300, aggregation: 'mean', kind: 'numeric', through: NOW + 6 * MIN },
        );
        expect(points.map(p => p.v)).toEqual([21, 30]);
    });

    it('schreibt Zustände über leere Intervalle fort (ein Schalter bleibt an)', () => {
        const points = resample(
            [{ t: NOW, value: 1 }],
            { intervalSeconds: 300, aggregation: 'last', kind: 'binary', through: NOW + 15 * MIN },
        );
        expect(points.map(p => p.v)).toEqual([1, 1, 1, 1]);
    });

    it('schreibt eine Lücke NICHT fort — unavailable bleibt unavailable', () => {
        const points = resample(
            [
                { t: NOW, value: 21 },
                { t: NOW + 5 * MIN, value: null, gap: 'unavailable' },
            ],
            { intervalSeconds: 300, aggregation: 'last', kind: 'numeric', through: NOW + 15 * MIN },
        );
        expect(points.map(p => p.v)).toEqual([21, null, null, null]);
        expect(points.slice(1).every(p => p.q === 'unavailable')).toBe(true);
    });

    it('erfindet keine Summe für ein leeres Intervall', () => {
        const points = resample(
            [{ t: NOW, value: 5 }],
            { intervalSeconds: 300, aggregation: 'sum', kind: 'numeric', through: NOW + 10 * MIN },
        );
        expect(points.map(p => p.v)).toEqual([5, 0, 0]);
    });

    it('gibt nur aus, was nach dem Wasserzeichen liegt', () => {
        const points = resample(
            [{ t: NOW, value: 1 }, { t: NOW + 5 * MIN, value: 2 }, { t: NOW + 10 * MIN, value: 3 }],
            {
                intervalSeconds: 300,
                aggregation: 'last',
                kind: 'numeric',
                after: NOW + 5 * MIN,
                through: NOW + 10 * MIN,
            },
        );
        expect(points.map(p => p.t)).toEqual([NOW + 10 * MIN]);
    });
});

describe('Zustandsübersetzung von Home Assistant', () => {
    it('erkennt zweiwertige Zustände in beiden Richtungen', () => {
        expect(parseState('on', 'binary').value).toBe(1);
        expect(parseState('off', 'binary').value).toBe(0);
        expect(parseState('open', 'binary').value).toBe(1);
        expect(parseState('locked', 'binary').value).toBe(0);
    });

    it('erfasst unavailable/unknown als ausgewiesene Lücke', () => {
        expect(parseState('unavailable', 'numeric')).toEqual({ value: null, gap: 'unavailable' });
        expect(parseState('unknown', 'binary')).toEqual({ value: null, gap: 'unknown' });
    });

    it('macht aus nicht-numerischem Text keinen Wert', () => {
        const parsed = parseState('kaputt', 'numeric');
        expect(parsed.value).toBeNull();
        expect(parsed.gap).toContain('nicht numerisch');
    });

    it('stuft Lichter als zweiwertig ein, obwohl sie Helligkeit tragen', () => {
        expect(classifyEntity({
            entityId: 'light.wohnzimmer', name: 'Licht', domain: 'light', unit: undefined,
        })).toBe('binary');
        expect(classifyEntity({
            entityId: 'sensor.temperatur', name: 'T', domain: 'sensor', unit: '°C', stateClass: 'measurement',
        })).toBe('numeric');
        expect(classifyEntity({
            entityId: 'climate.wohnzimmer', name: 'Heizung', domain: 'climate',
        })).toBe('categorical');
    });
});

describe('Beobachtungsgrößen im Graphen', () => {
    it('legt an, liest zurück und hält die Dauer-Kodierung stabil', async () => {
        const handle = newHandle();
        const variable = await addVariable(handle, { intervalSeconds: 300 });
        expect(variable.iri).toBe(`${INSTANCE_BASE}u/default/variable/sensor-wohnzimmer-temperatur`);

        const read = await getVariable(handle, variable.id);
        expect(read?.intervalSeconds).toBe(300);
        expect(read?.aggregation).toBe('mean');
        expect(read?.enabled).toBe(true);
        expect(secondsToDuration(300)).toBe('PT5M');
        expect(durationToSeconds('PT5M')).toBe(300);
        expect(durationToSeconds('5 Minuten')).toBeNull();
    });

    it('lehnt eine unzulässige Verdichtung ab, statt sie zu korrigieren', async () => {
        const handle = newHandle();
        await expect(addVariable(handle, { kind: 'categorical', aggregation: 'mean' }))
            .rejects.toThrow(/nicht zulässig/);
    });

    it('schaltet die Erfassung aus, ohne den Bestand zu berühren', async () => {
        const handle = newHandle();
        const variable = await addVariable(handle);
        const updated = await updateVariable(handle, variable.id, { enabled: false });
        expect(updated?.enabled).toBe(false);
        expect((await listVariables(handle))).toHaveLength(1);
    });
});

describe('Erfassungslauf', () => {
    it('holt beim ersten Lauf die Vergangenheit und danach nur den Zuwachs', async () => {
        const handle = newHandle();
        const files = createMemoryFileSystem();
        await addVariable(handle, { intervalSeconds: 300, aggregation: 'last' });

        const history: HaHistoryPoint[] = [
            { entityId: 'sensor.wohnzimmer_temperatur', t: NOW - 60 * MIN, state: '20.0' },
            { entityId: 'sensor.wohnzimmer_temperatur', t: NOW - 30 * MIN, state: '21.0' },
        ];
        const { client, windows } = fakeClient(history);

        const first = await captureObservations(handle, {
            files, root: ROOT, clientOverride: client, now: () => new Date(NOW),
        });
        expect(first.results[0].status).toBe('captured');
        expect(first.results[0].backfill).toBe(true);
        expect(first.results[0].appended).toBeGreaterThan(0);
        // Backfill greift 14 Tage zurück.
        expect(Date.parse(windows[0].from)).toBeLessThan(NOW - 13 * 86_400_000);

        windows.length = 0;
        history.push({ entityId: 'sensor.wohnzimmer_temperatur', t: NOW + 10 * MIN, state: '22.0' });
        const second = await captureObservations(handle, {
            files, root: ROOT, clientOverride: client, now: () => new Date(NOW + 20 * MIN),
        });
        expect(second.results[0].backfill).toBe(false);
        // Der zweite Lauf fragt nur noch ab dem Wasserzeichen.
        expect(Date.parse(windows[0].from)).toBeGreaterThanOrEqual(NOW);
    });

    it('ist idempotent: derselbe Lauf zweimal fügt nichts hinzu', async () => {
        const handle = newHandle();
        const files = createMemoryFileSystem();
        await addVariable(handle, { aggregation: 'last' });
        const { client } = fakeClient([
            { entityId: 'sensor.wohnzimmer_temperatur', t: NOW - 30 * MIN, state: '21.0' },
        ]);

        await captureObservations(handle, { files, root: ROOT, clientOverride: client, now: () => new Date(NOW) });
        const afterFirst = (await getVariable(handle, 'sensor-wohnzimmer-temperatur'))?.status.count ?? 0;
        expect(afterFirst).toBeGreaterThan(0);

        const repeat = await captureObservations(handle, {
            files, root: ROOT, clientOverride: client, now: () => new Date(NOW),
        });
        expect(repeat.results[0].appended).toBe(0);
        expect((await getVariable(handle, 'sensor-wohnzimmer-temperatur'))?.status.count).toBe(afterFirst);
    });

    it('schreibt KEINEN Messwert in den Graphen — nur Regel und Abdeckung (Invariante C3)', async () => {
        const handle = newHandle();
        const files = createMemoryFileSystem();
        await addVariable(handle, { aggregation: 'last' });
        const { client } = fakeClient([
            { entityId: 'sensor.wohnzimmer_temperatur', t: NOW - 30 * MIN, state: '21.5' },
        ]);
        await captureObservations(handle, { files, root: ROOT, clientOverride: client, now: () => new Date(NOW) });

        const meta: string[] = [];
        for await (const quad of handle.store.dump(namedNode(handle.iri.sharedGraph('meta')))) {
            meta.push(quad.object.value);
        }
        // Der Messwert 21.5 taucht in keinem Objekt auf.
        expect(meta).not.toContain('21.5');
        // Abdeckung und Anzahl dagegen schon.
        const variable = await getVariable(handle, 'sensor-wohnzimmer-temperatur');
        expect(variable?.status.count).toBeGreaterThan(0);
        expect(variable?.status.capturedThrough).toBeTruthy();

        // Gegenprobe über den Typ: der Knoten IST eine ow:Variable.
        const types: string[] = [];
        for await (const quad of handle.store.dump(namedNode(handle.iri.sharedGraph('meta')))) {
            if (quad.subject.value === variable?.iri && quad.predicate.value === RDF.type) {
                types.push(quad.object.value);
            }
        }
        expect(types).toContain(OW.Variable);
    });

    it('überspringt ausgeschaltete Größen und macht daraus keinen Fehler', async () => {
        const handle = newHandle();
        const files = createMemoryFileSystem();
        const variable = await addVariable(handle);
        await updateVariable(handle, variable.id, { enabled: false });
        const { client } = fakeClient([]);

        const report = await captureObservations(handle, {
            files, root: ROOT, clientOverride: client, now: () => new Date(NOW),
        });
        expect(report.results).toHaveLength(0);
        expect(report.message).toContain('Keine aktive Beobachtungsgröße');

        // Ausdrücklich benannt läuft sie trotzdem nicht — nur gemeldet.
        const forced = await captureObservations(handle, {
            files, root: ROOT, clientOverride: client, variableIds: [variable.id], now: () => new Date(NOW),
        });
        expect(forced.results[0].status).toBe('skipped');
    });

    it('hält einen Fehler bei einer Größe von den anderen fern', async () => {
        const handle = newHandle();
        const files = createMemoryFileSystem();
        await addVariable(handle, { id: 'gut', source: 'sensor.gut', aggregation: 'last' });
        await addVariable(handle, { id: 'schlecht', source: 'sensor.schlecht', aggregation: 'last' });

        const client = {
            async history(entityIds: ReadonlyArray<string>): Promise<HaHistoryPoint[]> {
                if (entityIds.includes('sensor.schlecht')) throw new Error('Sensor antwortet nicht');
                return [{ entityId: 'sensor.gut', t: NOW - 10 * MIN, state: '1' }];
            },
        } as unknown as HomeAssistantClient;

        const report = await captureObservations(handle, {
            files, root: ROOT, clientOverride: client, now: () => new Date(NOW),
        });
        const byId = new Map(report.results.map(result => [result.variableId, result]));
        expect(byId.get('gut')?.status).toBe('captured');
        expect(byId.get('schlecht')?.status).toBe('failed');
        // Der Fehler steht am Zustand der EINEN Größe.
        expect((await getVariable(handle, 'schlecht'))?.status.state).toBe('error');
        expect((await getVariable(handle, 'gut'))?.status.state).toBe('idle');
    });

    it('erfasst eine Lücke, statt sie zu überspringen', async () => {
        const handle = newHandle();
        const files = createMemoryFileSystem();
        await addVariable(handle, { id: 'fenster', source: 'binary_sensor.fenster', kind: 'binary', aggregation: 'last' });
        const { client } = fakeClient([
            { entityId: 'binary_sensor.fenster', t: NOW - 30 * MIN, state: 'on' },
            { entityId: 'binary_sensor.fenster', t: NOW - 20 * MIN, state: 'unavailable' },
        ]);
        await captureObservations(handle, { files, root: ROOT, clientOverride: client, now: () => new Date(NOW) });

        const observations = new ObservationStore({ files, root: ROOT, userId: 'default' });
        const read = await observations.read('fenster');
        expect(read.observations.some(point => point.v === 1)).toBe(true);
        expect(read.observations.some(point => point.v === null && point.q === 'unavailable')).toBe(true);
    });

    it('meldet einen fehlenden Zugang als Fehler und erfindet keine leere Erfassung', async () => {
        const handle = newHandle();
        const files = createMemoryFileSystem();
        await addVariable(handle);

        const report = await captureObservations(handle, { files, root: ROOT, now: () => new Date(NOW) });
        expect(report.results[0].status).toBe('failed');
        expect(report.message).toContain('Keine Home-Assistant-Verbindung');
    });
});

describe('Variablen-ID aus einer entity_id', () => {
    it('bleibt stabil und IRI-sicher', () => {
        expect(variableIdFor('sensor.wohnzimmer_temperatur')).toBe('sensor-wohnzimmer-temperatur');
        expect(variableIdFor('binary_sensor.tür_küche')).toBe('binary-sensor-tuer-kueche');
    });
});
