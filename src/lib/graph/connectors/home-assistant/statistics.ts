/**
 * Long-Term-Statistics von Home Assistant — der Blick zurück über den
 * Recorder-Horizont hinaus (CAUSAL_LAYER_SPEC §15.5).
 *
 * Der Recorder hält vollständige Zustandswechsel nur `purge_keep_days`
 * (Standard 10 Tage). Was bleibt, sind **stündliche Aggregate**, und die
 * nur für numerische Größen mit `state_class` — die Wirkungsseite
 * überlebt, die Ursachenseite nicht. Diese Datei holt genau die
 * überlebende Hälfte: nicht als Ersatz für die Erfassung (C3), sondern
 * als Verlängerung ihres Bestands nach hinten, für die Zeit, in der es
 * diesen Workspace noch nicht gab.
 *
 * Drei Entscheidungen, die inhaltlich zählen:
 *
 *  1. **Ein Aggregat je Stunde ist ein Punkt je Stunde.** Es wird nichts
 *     auf ein feineres Raster gehoben — wer einen Stundenmittelwert
 *     zwölfmal in ein Fünf-Minuten-Raster schreibt, erfindet elf
 *     Messungen und bläht jede spätere Fallzahl auf. Verdichten ist
 *     zulässig, Verfeinern nicht (dieselbe Regel wie im Panel, §C4).
 *  2. **Die Verdichtung der Größe entscheidet das Feld**, nicht
 *     umgekehrt: `mean` → `mean`, `min` → `min`, `max` → `max`,
 *     `last` → `state`. Eine Größe mit Mittelwert-Regel aus dem
 *     Maximum-Feld zu füllen, wäre eine andere Größe.
 *  3. **Summen werden abgelehnt.** Das Feld `sum` der Statistik ist ein
 *     fortlaufender Zählerstand seit Beginn der Aufzeichnung, nicht die
 *     Summe je Intervall. Es sieht aus wie die erfasste Größe und ist
 *     eine andere — deshalb gibt es hier keinen Wert statt eines
 *     falschen.
 *
 * Geschrieben wird von hier nichts: Der Zugang ist lesend (Invariante
 * C10), wie der ganze Home-Assistant-Connector.
 */

import type { Aggregation } from '../../observations/types';
import type { RawPoint } from '../../observations/resample';
import type { HaAccess } from './api';
import { websocketUrlFor, type WebSocketLike, type WebSocketOpener } from './websocket';

/** Raster der Statistik. Gebraucht wird `hour` — der Rest ist ihre Sprache. */
export type StatisticsPeriod = 'hour' | 'day' | 'week' | 'month';

/** Sekunden je Raster — die Auflösung, die ein Rückgriff höchstens hat. */
export const STATISTICS_PERIOD_SECONDS: Readonly<Record<StatisticsPeriod, number>> = {
    hour: 3600,
    day: 86_400,
    week: 604_800,
    month: 2_592_000,
};

/** Ein Statistik-Datensatz, quelltreu bis auf normalisierte Zeitstempel. */
export interface StatisticsRow {
    /** Beginn des Intervalls, Millisekunden seit Epoch. */
    start: number;
    mean?: number;
    min?: number;
    max?: number;
    sum?: number;
    /** Zustand am Ende des Intervalls (nur bei Zähler-Sensoren). */
    state?: number;
}

/** Feld der Statistik, aus dem die Reihe gefüllt wird. */
export type StatisticsField = 'mean' | 'min' | 'max' | 'state';

/**
 * Das Feld zur Verdichtung der Größe — oder eine Begründung, warum es
 * keines gibt. Der zweite Fall ist kein Sonderfall, sondern der Grund,
 * warum diese Funktion existiert: Ein stillschweigend anderes Feld wäre
 * eine stillschweigend andere Größe.
 */
export function statisticsFieldFor(
    aggregation: Aggregation,
): { field: StatisticsField } | { problem: string } {
    switch (aggregation) {
        case 'mean':
            return { field: 'mean' };
        case 'min':
            return { field: 'min' };
        case 'max':
            return { field: 'max' };
        case 'last':
            return { field: 'state' };
        case 'sum':
        default:
            return {
                problem: 'Die Langzeit-Statistik führt bei Summen einen fortlaufenden Zählerstand '
                    + '(Feld „sum"), nicht die Summe je Intervall. Das ist eine andere Größe als die '
                    + 'hier erfasste — ein Rückgriff würde Zählerstände als Intervallsummen ausgeben.',
            };
    }
}

/** Zeitstempel der Statistik: neuere Fassungen liefern ms, ältere ISO. */
function parseStamp(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        // Sekunden oder Millisekunden — vor 2001 liegt hier nichts.
        return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
    }
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function parseNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
}

/**
 * Liest die Zeilen einer Größe aus der Antwort. Unbrauchbare Einträge
 * werden übersprungen und gezählt, nie geraten — dieselbe
 * Fehlertoleranz-Regel wie beim Import (SPEC §6.1).
 */
export function parseStatisticsRows(raw: unknown): { rows: StatisticsRow[]; unusable: number } {
    if (!Array.isArray(raw)) return { rows: [], unusable: 0 };
    const rows: StatisticsRow[] = [];
    let unusable = 0;
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            unusable += 1;
            continue;
        }
        const record = entry as Record<string, unknown>;
        const start = parseStamp(record.start);
        if (start === null) {
            unusable += 1;
            continue;
        }
        const row: StatisticsRow = { start };
        const mean = parseNumber(record.mean);
        const min = parseNumber(record.min);
        const max = parseNumber(record.max);
        const sum = parseNumber(record.sum);
        const state = parseNumber(record.state);
        if (mean !== undefined) row.mean = mean;
        if (min !== undefined) row.min = min;
        if (max !== undefined) row.max = max;
        if (sum !== undefined) row.sum = sum;
        if (state !== undefined) row.state = state;
        rows.push(row);
    }
    rows.sort((a, b) => a.start - b.start);
    return { rows, unusable };
}

/**
 * Aus Zeilen werden Rohpunkte — einer je Intervall, am Intervallbeginn.
 * Zeilen ohne das gebrauchte Feld sind keine Lücke im Sinne der Erfassung
 * (der Sensor hat nichts gemeldet, weil es ihn noch nicht gab), sondern
 * schlicht nichts: Sie werden gezählt und weggelassen, statt als
 * `unavailable` eine Aussage zu erfinden.
 */
export function statisticsPoints(
    rows: readonly StatisticsRow[],
    field: StatisticsField,
): { points: RawPoint[]; missingField: number } {
    const points: RawPoint[] = [];
    let missingField = 0;
    for (const row of rows) {
        const value = row[field];
        if (value === undefined) {
            missingField += 1;
            continue;
        }
        points.push({ t: row.start, value });
    }
    return { points, missingField };
}

interface PendingResult {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
}

/**
 * Zeitlimit je Schritt (Anmeldung, Kommando). Ohne es bliebe ein Lauf
 * hängen, wenn Home Assistant die Verbindung offen hält und schweigt —
 * und der Erfassungslauf daneben stünde still.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Ein Kommando, eine Antwort, dann zu. Der Client hält keine Verbindung
 * offen und kennt keine Abonnements — für den Rückgriff auf die Statistik
 * ist beides nicht nötig, und beides wäre ein Dauerzustand, den niemand
 * überwacht.
 */
export class HomeAssistantStatisticsClient {
    constructor(
        private readonly access: HaAccess,
        private readonly open: WebSocketOpener,
        private readonly timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
    ) {}

    /**
     * Holt die Statistik mehrerer Größen im Fenster. Ergebnis ist je
     * Quellschlüssel die Liste der Zeilen; fehlt ein Schlüssel in der
     * Antwort, hat Home Assistant für ihn nichts (und das ist eine
     * Auskunft, keine Störung).
     */
    async statisticsDuringPeriod(
        statisticIds: ReadonlyArray<string>,
        startIso: string,
        endIso: string,
        period: StatisticsPeriod = 'hour',
    ): Promise<Map<string, { rows: StatisticsRow[]; unusable: number }>> {
        const result = new Map<string, { rows: StatisticsRow[]; unusable: number }>();
        if (statisticIds.length === 0) return result;

        const socket = await this.open(websocketUrlFor(this.access.baseUrl));
        try {
            const session = new Session(socket, this.timeoutMs);
            await session.authenticate(this.access);
            const payload = await session.command({
                type: 'recorder/statistics_during_period',
                start_time: startIso,
                end_time: endIso,
                statistic_ids: [...statisticIds],
                period,
            });
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return result;
            for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
                result.set(key, parseStatisticsRows(value));
            }
            return result;
        } finally {
            socket.close();
        }
    }
}

/**
 * Der Protokoll-Ablauf: `auth_required` abwarten, Token senden, auf
 * `auth_ok` warten, dann Kommandos mit fortlaufender ID stellen. Die
 * Antwort wird über die ID zugeordnet — Home Assistant darf dazwischen
 * senden, was es will.
 */
class Session {
    private nextId = 1;
    private readonly pending = new Map<number, PendingResult>();
    private authResolve?: (message: Record<string, unknown>) => void;
    /**
     * Home Assistant grüßt von sich aus, sobald die Verbindung steht. Wer
     * erst danach zuhört, hätte den Gruß verpasst — deshalb wird
     * gepuffert statt auf die Reihenfolge vertraut.
     */
    private readonly authQueue: Array<Record<string, unknown>> = [];
    private closedReason: string | null = null;

    constructor(
        private readonly socket: WebSocketLike,
        private readonly timeoutMs: number,
    ) {
        socket.onMessage(payload => this.receive(payload));
        socket.onClose(reason => {
            this.closedReason = reason;
            for (const [, entry] of this.pending) entry.reject(new Error(reason));
            this.pending.clear();
        });
    }

    private receive(payload: string): void {
        let parsed: unknown;
        try {
            parsed = JSON.parse(payload);
        } catch {
            return;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        const message = parsed as Record<string, unknown>;
        const type = typeof message.type === 'string' ? message.type : '';

        if (type === 'auth_required' || type === 'auth_ok' || type === 'auth_invalid') {
            const waiting = this.authResolve;
            this.authResolve = undefined;
            if (waiting) waiting(message);
            else this.authQueue.push(message);
            return;
        }
        if (type !== 'result') return;
        const id = typeof message.id === 'number' ? message.id : -1;
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        if (message.success === false) {
            const error = message.error;
            const detail = error && typeof error === 'object' && !Array.isArray(error)
                ? String((error as Record<string, unknown>).message ?? '')
                : '';
            entry.reject(new Error(
                `Home Assistant lehnt die Statistik-Abfrage ab${detail ? `: ${detail}` : ''}.`,
            ));
            return;
        }
        entry.resolve(message.result);
    }

    /**
     * Sendet und nimmt der wartenden Antwort im Fehlerfall die Zähne: Ein
     * gescheitertes `send` lässt sonst eine Zusage zurück, die niemand
     * mehr abwartet — und die eine Minute später als unbehandelte
     * Ablehnung auftaucht, weit weg von ihrer Ursache.
     */
    private send(answer: Promise<unknown>, body: Record<string, unknown>): void {
        try {
            this.socket.send(JSON.stringify(body));
        } catch (error) {
            answer.catch(() => undefined);
            throw error instanceof Error ? error : new Error(String(error));
        }
    }

    /** Bricht ein Warten ab, statt es unbegrenzt laufen zu lassen. */
    private withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`Home Assistant antwortet nicht (${what}, Zeitlimit ${this.timeoutMs} ms).`));
            }, this.timeoutMs);
            promise.then(
                value => {
                    clearTimeout(timer);
                    resolve(value);
                },
                error => {
                    clearTimeout(timer);
                    reject(error instanceof Error ? error : new Error(String(error)));
                },
            );
        });
    }

    /** Wartet auf die nächste Nachricht des Auth-Kanals. */
    private nextAuthMessage(): Promise<Record<string, unknown>> {
        const buffered = this.authQueue.shift();
        if (buffered) return Promise.resolve(buffered);
        if (this.closedReason) return Promise.reject(new Error(this.closedReason));
        return this.withTimeout(new Promise<Record<string, unknown>>(resolve => {
            this.authResolve = resolve;
        }), 'Anmeldung');
    }

    async authenticate(access: HaAccess): Promise<void> {
        const greeting = await this.nextAuthMessage();
        if (greeting.type !== 'auth_required') {
            throw new Error(
                'Home Assistant begrüßt die WebSocket-Verbindung nicht wie erwartet '
                + `(erhalten: „${String(greeting.type)}").`,
            );
        }
        const answer = this.nextAuthMessage();
        this.send(answer, { type: 'auth', access_token: access.token });
        const verdict = await answer;
        if (verdict.type === 'auth_ok') return;
        throw new Error(
            access.origin === 'supervisor'
                ? 'Home Assistant weist den Supervisor-Token an der WebSocket-API ab. Fehlt '
                  + '"homeassistant_api: true" im Add-on-Manifest, wurde das Add-on danach nicht neu gestartet?'
                : 'Home Assistant weist den Token an der WebSocket-API ab. Ist der Long-Lived '
                  + 'Access Token gültig?',
        );
    }

    async command(body: Record<string, unknown>): Promise<unknown> {
        if (this.closedReason) throw new Error(this.closedReason);
        const id = this.nextId;
        this.nextId += 1;
        const answer = this.withTimeout(new Promise<unknown>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
        }), 'Statistik-Abfrage');
        this.send(answer, { ...body, id });
        return answer;
    }
}
