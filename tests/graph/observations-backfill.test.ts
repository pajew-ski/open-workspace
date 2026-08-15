// @vitest-environment node
/**
 * Abnahme des Rückgriffs auf die Long-Term-Statistics
 * (CAUSAL_LAYER_SPEC §15.5 — offen geblieben aus C3).
 *
 * Geprüft wird, was den Rückgriff von einer zweiten Erfassung
 * unterscheidet — jede einzelne Zusage verhindert eine stille Unwahrheit:
 *
 *  1. **Die Statistik ist halbiert.** Schalter, Fenster, Anwesenheit
 *     stehen dort nicht; eine zweiwertige Größe wird mit Begründung
 *     abgelehnt statt leer zurückzukommen.
 *  2. **Eine Summe ist dort ein Zählerstand**, nicht die Summe je
 *     Intervall — also gibt es keinen Wert statt eines falschen.
 *  3. **Ein Aggregat je Stunde bleibt ein Punkt je Stunde.** Nichts wird
 *     auf das feinere Erfassungsraster gehoben.
 *  4. **Ein erfasster Tag wird nie angefasst.** Der feine Bestand hat
 *     Vorrang; die Datei bleibt byte-identisch.
 *  5. **Der Rückgriff endet dort, wo die Erfassung noch selbst hinkommt.**
 *  6. **Er ist idempotent**: der zweite Lauf schreibt nichts.
 *  7. **Kein Messwert im Graphen** (Invariante C3) — dafür die
 *     nachgefüllte Strecke als eigene Aussage, damit später niemand einen
 *     Stundenmittelwert für eine Messung hält.
 *  8. **Der Kanal ist abgesichert** wie der HTTP-Abruf: nur ws(s), keine
 *     privaten Ziele ohne ausdrückliche Freigabe.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@/lib/graph/store/oxigraph';
import { createIriFactory } from '@/lib/graph/iri';
import { namedNode } from '@/lib/graph/rdf';
import { OW } from '@/lib/graph/vocab';
import { createMemoryFileSystem } from '@/lib/platform/runtime/memfs';
import { ObservationStore } from '@/lib/graph/observations/store';
import { createVariable, getVariable } from '@/lib/graph/observations/variables';
import { backfillFromStatistics, refusalFor } from '@/lib/graph/observations/backfill';
import {
    HomeAssistantStatisticsClient,
    parseStatisticsRows,
    statisticsFieldFor,
    statisticsPoints,
} from '@/lib/graph/connectors/home-assistant/statistics';
import {
    assertAllowedWebSocketUrl,
    websocketUrlFor,
    type WebSocketLike,
} from '@/lib/graph/connectors/home-assistant/websocket';
import type { Aggregation, ObservationKind, VariableView } from '@/lib/graph/observations/types';

const INSTANCE_BASE = 'urn:ow:33333333-4444-4555-8666-777777777777:';
const ROOT = '/data';
const HOUR = 3_600_000;
/** Fester „Jetzt"-Zeitpunkt: 2026-08-13T12:00:00Z. */
const NOW = Date.parse('2026-08-13T12:00:00.000Z');

function newHandle() {
    return { store: new OxigraphStore(), iri: createIriFactory(INSTANCE_BASE) };
}

async function addVariable(
    handle: ReturnType<typeof newHandle>,
    overrides: Partial<{
        id: string; source: string; sourceKind: string;
        kind: ObservationKind; aggregation: Aggregation; intervalSeconds: number;
    }> = {},
): Promise<VariableView> {
    return createVariable(handle, {
        id: overrides.id ?? 'sensor-wohnzimmer-temperatur',
        name: 'Wohnzimmer Temperatur',
        sourceKind: overrides.sourceKind ?? 'home-assistant',
        source: overrides.source ?? 'sensor.wohnzimmer_temperatur',
        kind: overrides.kind ?? 'numeric',
        aggregation: overrides.aggregation ?? 'mean',
        intervalSeconds: overrides.intervalSeconds ?? 300,
    });
}

/**
 * Gescripteter Doppelgänger der WebSocket-API: begrüßt, prüft den Token
 * und beantwortet genau ein Kommando. Er merkt sich, was gesendet wurde —
 * das Fenster der Abfrage ist Teil der Abnahme.
 */
function fakeSocket(options: {
    authOk?: boolean;
    rows?: unknown;
    failure?: string;
}): { socket: WebSocketLike; sent: Array<Record<string, unknown>> } {
    const sent: Array<Record<string, unknown>> = [];
    let deliver: (payload: string) => void = () => undefined;
    const send = (message: Record<string, unknown>) => {
        queueMicrotask(() => deliver(JSON.stringify(message)));
    };
    const socket: WebSocketLike = {
        send(payload: string) {
            const message = JSON.parse(payload) as Record<string, unknown>;
            sent.push(message);
            if (message.type === 'auth') {
                send(options.authOk === false
                    ? { type: 'auth_invalid', message: 'invalid access token' }
                    : { type: 'auth_ok', ha_version: '2026.8.0' });
                return;
            }
            if (message.type === 'recorder/statistics_during_period') {
                if (options.failure) {
                    send({ id: message.id, type: 'result', success: false, error: { message: options.failure } });
                    return;
                }
                send({
                    id: message.id,
                    type: 'result',
                    success: true,
                    result: { [String((message.statistic_ids as string[])[0])]: options.rows ?? [] },
                });
            }
        },
        close: () => undefined,
        onMessage(handler) {
            deliver = handler;
            // Home Assistant grüßt von sich aus, sobald die Verbindung steht.
            send({ type: 'auth_required', ha_version: '2026.8.0' });
        },
        onClose: () => undefined,
    };
    return { socket, sent };
}

/** Stundenzeilen ab `startMs`, mit Mittelwert — die Form der Statistik. */
function hourlyRows(startMs: number, count: number, value = 20): Array<Record<string, unknown>> {
    return Array.from({ length: count }, (_, index) => ({
        start: startMs + index * HOUR,
        end: startMs + (index + 1) * HOUR,
        mean: value + index * 0.1,
        min: value - 1,
        max: value + 1,
    }));
}

function clientFor(options: Parameters<typeof fakeSocket>[0]) {
    const made = fakeSocket(options);
    const client = new HomeAssistantStatisticsClient(
        { baseUrl: 'https://ha.example.org', token: 'geheim', origin: 'configured' },
        async () => made.socket,
    );
    return { client, sent: made.sent };
}

describe('Adresse und Absicherung der WebSocket-API', () => {
    afterEach(() => {
        delete process.env.ALLOW_LOCAL_TOOL_URLS;
    });

    it('leitet die ws-Adresse aus derselben Basis ab wie den REST-Zugang', () => {
        expect(websocketUrlFor('https://ha.example.org')).toBe('wss://ha.example.org/api/websocket');
        expect(websocketUrlFor('http://supervisor/core')).toBe('ws://supervisor/core/api/websocket');
        expect(websocketUrlFor('https://ha.example.org/')).toBe('wss://ha.example.org/api/websocket');
    });

    it('nimmt nur ws(s) und blockiert private Ziele — dieselbe Politik wie beim Abruf', () => {
        expect(() => assertAllowedWebSocketUrl('https://ha.example.org/api/websocket')).toThrow(/ws\(s\)/);
        expect(() => assertAllowedWebSocketUrl('ws://192.168.1.10/api/websocket')).toThrow(/ALLOW_LOCAL_TOOL_URLS/);
        expect(assertAllowedWebSocketUrl('wss://ha.example.org/api/websocket').host).toBe('ha.example.org');

        process.env.ALLOW_LOCAL_TOOL_URLS = '1';
        expect(assertAllowedWebSocketUrl('ws://192.168.1.10/api/websocket').host).toBe('192.168.1.10');
    });
});

describe('Statistik-Protokoll', () => {
    it('meldet sich an, fragt das Stundenraster ab und liest die Zeilen', async () => {
        const start = Date.parse('2026-01-01T00:00:00.000Z');
        const { client, sent } = clientFor({ rows: hourlyRows(start, 3) });

        const answer = await client.statisticsDuringPeriod(
            ['sensor.wohnzimmer_temperatur'],
            new Date(start).toISOString(),
            new Date(start + 3 * HOUR).toISOString(),
        );

        expect(sent[0]).toEqual({ type: 'auth', access_token: 'geheim' });
        expect(sent[1]).toMatchObject({
            type: 'recorder/statistics_during_period',
            period: 'hour',
            statistic_ids: ['sensor.wohnzimmer_temperatur'],
        });
        const entry = answer.get('sensor.wohnzimmer_temperatur');
        expect(entry?.rows).toHaveLength(3);
        expect(entry?.rows[0].mean).toBe(20);
        expect(entry?.rows[0].start).toBe(start);
    });

    it('nennt beim abgewiesenen Token den Token, nicht nur „Fehler"', async () => {
        const { client } = clientFor({ authOk: false, rows: [] });
        await expect(client.statisticsDuringPeriod(['sensor.a'], '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'))
            .rejects.toThrow(/Token/);
    });

    it('reicht die Ablehnung von Home Assistant im Klartext durch', async () => {
        const { client } = clientFor({ failure: 'Statistics not enabled' });
        await expect(client.statisticsDuringPeriod(['sensor.a'], '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'))
            .rejects.toThrow(/Statistics not enabled/);
    });

    it('versteht Zeitstempel als Millisekunden, Sekunden und ISO-Text', () => {
        const iso = '2026-01-01T00:00:00.000Z';
        const ms = Date.parse(iso);
        const { rows, unusable } = parseStatisticsRows([
            { start: ms, mean: 1 },
            { start: ms / 1000, mean: 2 },
            { start: iso, mean: 3 },
            { start: 'kaputt', mean: 4 },
            'unbrauchbar',
        ]);
        expect(rows.map(row => row.start)).toEqual([ms, ms, ms]);
        expect(unusable).toBe(2);
    });
});

describe('Feld und Punkte', () => {
    it('bindet das Feld an die Verdichtung der Größe', () => {
        expect(statisticsFieldFor('mean')).toEqual({ field: 'mean' });
        expect(statisticsFieldFor('min')).toEqual({ field: 'min' });
        expect(statisticsFieldFor('max')).toEqual({ field: 'max' });
        expect(statisticsFieldFor('last')).toEqual({ field: 'state' });
    });

    it('lehnt Summen ab: das Feld „sum" ist ein Zählerstand, keine Intervallsumme', () => {
        const verdict = statisticsFieldFor('sum');
        expect('problem' in verdict && verdict.problem).toMatch(/Zählerstand/);
    });

    it('erfindet für eine Zeile ohne das gebrauchte Feld keinen Wert', () => {
        const start = Date.parse('2026-01-01T00:00:00.000Z');
        const { points, missingField } = statisticsPoints(
            [{ start, mean: 21 }, { start: start + HOUR }, { start: start + 2 * HOUR, mean: 22 }],
            'mean',
        );
        expect(points.map(point => point.value)).toEqual([21, 22]);
        expect(missingField).toBe(1);
    });
});

describe('Speicher: nur füllen, nie überschreiben', () => {
    it('lässt einen Tag mit Messpunkten unangetastet und füllt nur die leeren', async () => {
        const files = createMemoryFileSystem();
        const store = new ObservationStore({ files, root: ROOT, userId: 'default' });
        const captured = Date.parse('2026-08-13T10:00:00.000Z');
        await store.append('v1', [{ t: captured, v: 21 }]);
        const before = await files.readFile(`${ROOT}/observations/default/v1/2026-08-13.ndjson`);

        const result = await store.backfill('v1', [
            { t: Date.parse('2026-08-11T00:00:00.000Z'), v: 1 },
            { t: Date.parse('2026-08-12T00:00:00.000Z'), v: 2 },
            // Derselbe Tag, den die Erfassung schon hält — bleibt draußen.
            { t: Date.parse('2026-08-13T00:00:00.000Z'), v: 3 },
        ]);

        expect(result.written).toBe(2);
        expect(result.days).toEqual(['2026-08-11', '2026-08-12']);
        expect(result.skippedDays).toEqual(['2026-08-13']);
        expect(await files.readFile(`${ROOT}/observations/default/v1/2026-08-13.ndjson`)).toBe(before);

        // Zweiter Lauf: die Tage sind jetzt da, es passiert nichts mehr.
        const again = await store.backfill('v1', [{ t: Date.parse('2026-08-11T00:00:00.000Z'), v: 9 }]);
        expect(again.written).toBe(0);
        expect((await store.read('v1')).observations.filter(point => point.v === 9)).toHaveLength(0);
    });
});

describe('Rückgriff auf die Statistik', () => {
    it('lehnt zweiwertige Größen ab — die Ursachenseite steht dort nicht', async () => {
        const handle = newHandle();
        const files = createMemoryFileSystem();
        const variable = await addVariable(handle, {
            id: 'fenster', source: 'binary_sensor.fenster', kind: 'binary', aggregation: 'last',
        });
        expect(refusalFor(variable)).toMatch(/state_class/);

        const { client } = clientFor({ rows: [] });
        const result = await backfillFromStatistics(handle, 'fenster', {
            files, root: ROOT, clientOverride: client, now: () => new Date(NOW),
        });
        expect(result.status).toBe('refused');
        expect(result.message).toMatch(/Erfassung/);
        expect(result.appended).toBe(0);
    });

    it('lehnt Summen und fremde Quellarten ab', async () => {
        const handle = newHandle();
        const files = createMemoryFileSystem();
        await addVariable(handle, { id: 'strom', source: 'sensor.strom', aggregation: 'sum' });
        await addVariable(handle, {
            id: 'wetter', source: 'dwd#temperature', sourceKind: 'rest-timeseries', aggregation: 'mean',
        });
        const { client } = clientFor({ rows: [] });

        const summe = await backfillFromStatistics(handle, 'strom', {
            files, root: ROOT, clientOverride: client, now: () => new Date(NOW),
        });
        expect(summe.status).toBe('refused');
        expect(summe.message).toMatch(/Zählerstand/);

        const fremd = await backfillFromStatistics(handle, 'wetter', {
            files, root: ROOT, clientOverride: client, now: () => new Date(NOW),
        });
        expect(fremd.status).toBe('refused');
        expect(fremd.message).toMatch(/rest-timeseries/);
    });

    it('füllt die Zeit vor dem Bestand, in Stundenschritten, und lässt den erfassten Tag stehen', async () => {
        const handle = newHandle();
        const files = createMemoryFileSystem();
        await addVariable(handle);

        // Erfasst ist der 13.08. — davor liegt nichts.
        const store = new ObservationStore({ files, root: ROOT, userId: 'default' });
        await store.append('sensor-wohnzimmer-temperatur', [{ t: NOW - 2 * HOUR, v: 21 }]);
        const existing = await getVariable(handle, 'sensor-wohnzimmer-temperatur');
        await createdCoverage(handle, existing, NOW - 2 * HOUR);

        // Die Statistik hält 48 Stunden ab dem 20.07.
        const statsStart = Date.parse('2026-07-20T00:00:00.000Z');
        const { client, sent } = clientFor({ rows: hourlyRows(statsStart, 48) });

        const result = await backfillFromStatistics(handle, 'sensor-wohnzimmer-temperatur', {
            files, root: ROOT, clientOverride: client, now: () => new Date(NOW), days: 60,
        });

        expect(result.status).toBe('filled');
        expect(result.appended).toBe(48);
        expect(result.days).toEqual(['2026-07-20', '2026-07-21']);
        expect(result.intervalSeconds).toBe(3600);

        // Das Fenster endet dort, wo die Erfassung noch selbst hinkommt:
        // 14 Tage vor jetzt, auf Mitternacht abgerundet.
        const command = sent.find(message => message.type === 'recorder/statistics_during_period');
        expect(Date.parse(String(command?.end_time))).toBe(Date.parse('2026-07-30T00:00:00.000Z'));

        // Ein Punkt je Stunde — nichts wurde auf das Fünf-Minuten-Raster gehoben.
        const read = await store.read('sensor-wohnzimmer-temperatur');
        const backfilled = read.observations.filter(point => point.t < statsStart + 48 * HOUR);
        expect(backfilled).toHaveLength(48);
        expect(backfilled[1].t - backfilled[0].t).toBe(HOUR);
        // Der erfasste Punkt ist noch da.
        expect(read.observations.some(point => point.v === 21)).toBe(true);
    });

    it('schreibt die nachgefüllte Strecke in den Graphen — aber keinen Messwert (C3)', async () => {
        const handle = newHandle();
        const files = createMemoryFileSystem();
        await addVariable(handle);
        const statsStart = Date.parse('2026-07-20T00:00:00.000Z');
        const { client } = clientFor({ rows: hourlyRows(statsStart, 24, 20) });

        await backfillFromStatistics(handle, 'sensor-wohnzimmer-temperatur', {
            files, root: ROOT, clientOverride: client, now: () => new Date(NOW), days: 60,
        });

        const variable = await getVariable(handle, 'sensor-wohnzimmer-temperatur');
        // Die Lexik der Zeitstempel normalisiert der Store (die Millisekunden
        // fallen weg) — verglichen wird deshalb der Zeitpunkt, nicht der Text.
        expect(Date.parse(variable?.status.aggregate?.from ?? '')).toBe(statsStart);
        expect(Date.parse(variable?.status.aggregate?.through ?? '')).toBe(statsStart + 23 * HOUR);
        expect(variable?.status.aggregate?.intervalSeconds).toBe(3600);
        expect(variable?.status.aggregate?.summary).toMatch(/Stundenwerte/);
        expect(variable?.status.count).toBe(24);

        const objects: string[] = [];
        const predicates: string[] = [];
        for await (const quad of handle.store.dump(namedNode(handle.iri.sharedGraph('meta')))) {
            objects.push(quad.object.value);
            predicates.push(quad.predicate.value);
        }
        // Kein Messwert der Reihe steht im Graphen …
        expect(objects).not.toContain('20');
        expect(objects).not.toContain('20.1');
        // … die Strecke dagegen schon, mit ihrer eigenen Auflösung.
        expect(predicates).toContain(OW.aggregatedFrom);
        expect(predicates).toContain(OW.aggregatedThrough);
        expect(predicates).toContain(OW.aggregateInterval);
    });

    it('ist idempotent: der zweite Rückgriff schreibt nichts mehr', async () => {
        const handle = newHandle();
        const files = createMemoryFileSystem();
        await addVariable(handle);
        const statsStart = Date.parse('2026-07-20T00:00:00.000Z');

        const first = await backfillFromStatistics(handle, 'sensor-wohnzimmer-temperatur', {
            files, root: ROOT, clientOverride: clientFor({ rows: hourlyRows(statsStart, 24) }).client,
            now: () => new Date(NOW), days: 60,
        });
        expect(first.appended).toBe(24);

        const second = await backfillFromStatistics(handle, 'sensor-wohnzimmer-temperatur', {
            files, root: ROOT, clientOverride: clientFor({ rows: hourlyRows(statsStart, 24) }).client,
            now: () => new Date(NOW), days: 60,
        });
        expect(second.status).toBe('noop');
        expect(second.appended).toBe(0);
        expect((await getVariable(handle, 'sensor-wohnzimmer-temperatur'))?.status.count).toBe(24);
    });

    /**
     * Derselbe Fehlertyp, der schon einmal die Kante zur Messquelle
     * verschluckt hat: Der Erfassungslauf baut den Zustand der Größe neu
     * auf, und was er dabei nicht mitnimmt, ist still weg. Der Bestand
     * behielte hier seine groben Stunden — nur wüsste es niemand mehr.
     */
    it('überlebt den nächsten Erfassungslauf', async () => {
        const handle = newHandle();
        const files = createMemoryFileSystem();
        await addVariable(handle, { aggregation: 'mean' });
        const statsStart = Date.parse('2026-07-20T00:00:00.000Z');
        await backfillFromStatistics(handle, 'sensor-wohnzimmer-temperatur', {
            files, root: ROOT, clientOverride: clientFor({ rows: hourlyRows(statsStart, 24) }).client,
            now: () => new Date(NOW), days: 60,
        });

        const { captureObservations } = await import('@/lib/graph/observations/capture');
        const client = {
            async history() {
                return [{ entityId: 'sensor.wohnzimmer_temperatur', t: NOW - 10 * 60_000, state: '21.0' }];
            },
        } as unknown as Parameters<typeof captureObservations>[1]['clientOverride'];
        await captureObservations(handle, {
            files, root: ROOT, ...(client ? { clientOverride: client } : {}), now: () => new Date(NOW),
        });

        const after = await getVariable(handle, 'sensor-wohnzimmer-temperatur');
        expect(Date.parse(after?.status.aggregate?.from ?? '')).toBe(statsStart);
        expect(after?.status.aggregate?.intervalSeconds).toBe(3600);
    });

    it('meldet eine leere Statistik als Auskunft, einen Abbruch als Fehler', async () => {
        const handle = newHandle();
        const files = createMemoryFileSystem();
        await addVariable(handle);

        const leer = await backfillFromStatistics(handle, 'sensor-wohnzimmer-temperatur', {
            files, root: ROOT, clientOverride: clientFor({ rows: [] }).client, now: () => new Date(NOW),
        });
        expect(leer.status).toBe('noop');
        expect(leer.message).toMatch(/keine Statistik/);

        const kaputt = await backfillFromStatistics(handle, 'sensor-wohnzimmer-temperatur', {
            files, root: ROOT, clientOverride: clientFor({ failure: 'Recorder is busy' }).client,
            now: () => new Date(NOW),
        });
        expect(kaputt.status).toBe('failed');
        expect(kaputt.message).toMatch(/Recorder is busy/);
        // Der Fehlschlag hinterlässt keine halbe Wahrheit an der Größe.
        expect((await getVariable(handle, 'sensor-wohnzimmer-temperatur'))?.status.aggregate).toBeUndefined();
    });

    it('nennt das fehlende Feld, statt ersatzweise ein anderes zu nehmen', async () => {
        const handle = newHandle();
        const files = createMemoryFileSystem();
        // „letzter Wert" braucht das Feld `state` — ein Messwert-Sensor hat es nicht.
        await addVariable(handle, { aggregation: 'last' });
        const statsStart = Date.parse('2026-07-20T00:00:00.000Z');
        const { client } = clientFor({ rows: hourlyRows(statsStart, 5) });

        const result = await backfillFromStatistics(handle, 'sensor-wohnzimmer-temperatur', {
            files, root: ROOT, clientOverride: client, now: () => new Date(NOW), days: 60,
        });
        expect(result.status).toBe('failed');
        expect(result.message).toMatch(/state/);
        expect(result.appended).toBe(0);
    });
});

/**
 * Setzt die Abdeckung, wie ein Erfassungslauf sie hinterlassen hätte —
 * ohne dafür einen ganzen Lauf zu bemühen.
 */
async function createdCoverage(
    handle: ReturnType<typeof newHandle>,
    variable: VariableView | null,
    fromMs: number,
): Promise<void> {
    if (!variable) throw new Error('Variable fehlt');
    const { saveVariable } = await import('@/lib/graph/observations/variables');
    await saveVariable(handle, {
        ...variable,
        status: {
            ...variable.status,
            capturedFrom: new Date(fromMs).toISOString(),
            capturedThrough: new Date(fromMs).toISOString(),
            count: 1,
        },
    });
}
