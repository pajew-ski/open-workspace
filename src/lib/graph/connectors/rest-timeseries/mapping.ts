/**
 * Die Abbildung einer offenen Zeitreihen-API auf Rohpunkte — rein, ohne
 * Netz und ohne Store (CAUSAL_LAYER_SPEC §10, Meilenstein C5).
 *
 * **Warum deklarativ statt je Quelle ein Stück Code**: Der Bedarf sind
 * Störgrößen, nicht Integrationen. Wetter, Strompreis, Einstrahlung und
 * Feiertage unterscheiden sich in drei Dingen — wie das Zeitfenster in
 * die URL kommt, wo im Dokument die Reihe steht und welche Form sie hat.
 * Alles andere ist gleich. Eine Beschreibung dieser drei Dinge ist
 * kürzer als ein Connector pro Quelle, sie ist als Datenstruktur
 * prüfbar, und sie erlaubt eine eigene Quelle ohne neuen Code
 * (Invariante 5: EIN Vertrag für alles Externe).
 *
 * Drei Formen decken die offenen Kataloge ab:
 *
 *  - `points` — eine Liste von Datensätzen, jeder mit Zeitstempel und
 *    Werten (Bright Sky, aWATTar).
 *  - `columns` — parallele Arrays, ein Zeitarray und je Größe eines
 *    (Open-Meteo). Verbreitet, weil kompakt; ohne eigene Form müsste man
 *    sie clientseitig umbauen und dabei die Indexbindung erfinden.
 *  - `intervals` — Zeitspannen mit einem Wert, der dazwischen gilt, und
 *    einem Wert außerhalb (Feiertage). Das ist die Form, in der
 *    Kalenderquellen liefern; ohne den Wert **außerhalb** entstünde eine
 *    Reihe, die nur aus Einsen besteht, und die wäre als Störgröße
 *    wertlos.
 *
 * Was hier bewusst NICHT passiert: schreiben. Werte gehen nie in den
 * Store (Invariante C3) — dieses Modul liefert Rohpunkte an dieselbe
 * Verdichtung, die auch Home Assistant durchläuft (`resample.ts`).
 */

import type { Aggregation, ObservationKind } from '../../observations/types';
import type { RawPoint } from '../../observations/resample';

/** Wie ein Zeitstempel in der Quelle bzw. in der URL geschrieben ist. */
export type TimeFormat = 'iso' | 'date' | 'unix-s' | 'unix-ms';

/** Form der Reihe im Quelldokument (siehe Kopfkommentar). */
export type SeriesShape = 'points' | 'columns' | 'intervals';

export type SourceFormat = 'json' | 'csv';

/** Wie das Zeitfenster in Anfragen zerlegt wird. */
export type WindowMode = 'range' | 'yearly';

/**
 * Filter auf Datensatz-Ebene. Gebraucht für regionale Gültigkeit
 * (Feiertage in Bayern), wo die Quelle die Region als Liste am Eintrag
 * führt und ein fehlendes Feld „gilt überall" bedeutet — die Voreinstellung
 * ist deshalb wählbar und nicht geraten.
 */
export interface RestFilter {
    field: string;
    /**
     * Wert, der im Feld enthalten sein muss (String oder Array). Fehlt er,
     * bleiben nur Einträge übrig, die zu dem Feld gar nichts sagen — das
     * ist der Fall „nur bundesweite Feiertage".
     */
    includes?: string;
    /** Was gilt, wenn das Feld fehlt oder leer ist. */
    whenAbsent: 'include' | 'exclude';
}

/** Eine Reihe innerhalb einer Quelle. */
export interface RestSeries {
    /** Schlüssel innerhalb der Quelle — Teil des Quellschlüssels. */
    key: string;
    name: string;
    kind: ObservationKind;
    /** Vorschlag für die Verdichtung beim Anlegen der Größe. */
    aggregation: Aggregation;
    /** Feld bzw. Spalte des Wertes; leer bei `constantValue`. */
    field: string;
    unit?: string;
    /** Schlüssel der beobachteten Größe (sosa:ObservableProperty). */
    observable?: string;
    /** Linearer Umrechnungsfaktor (z. B. €/MWh → ct/kWh). */
    scale?: number;
    offset?: number;
    /** `intervals`: Wert innerhalb der Zeitspanne. */
    constantValue?: number;
    /** `intervals`: Wert außerhalb; fehlt = Lücke statt Null. */
    defaultValue?: number;
    filter?: RestFilter;
    /** Ein Satz zur Rolle im Kausalmodell (UI, nicht Semantik). */
    role?: string;
}

/** Die vollständige Beschreibung einer Quelle. */
export interface RestSourceMapping {
    /** Anzeigename der Quelle (deutsch). */
    label: string;
    /** Basis-URL; darf `{year}` enthalten (windowMode `yearly`). */
    url: string;
    format: SourceFormat;
    shape: SeriesShape;
    /** Konstante Query-Parameter. */
    query: Record<string, string>;
    windowMode: WindowMode;
    /** Parameter-Namen des Zeitfensters (windowMode `range`). */
    fromParam?: string;
    toParam?: string;
    /** Schreibweise der Fenster-Parameter. */
    windowFormat: TimeFormat;
    /** Höchstlänge einer Anfrage in Tagen — schützt Quelle und Antwortgröße. */
    windowDays: number;
    /** Pfad zum Datenteil im JSON (Punktnotation, leer = Wurzel). */
    path?: string;
    /** Feld des Zeitstempels bzw. des Intervallbeginns. */
    timeField: string;
    /** `intervals`: Feld des Intervallendes. */
    endField?: string;
    /** `intervals`: Länge, falls die Quelle kein Ende nennt. */
    durationDays?: number;
    timeFormat: TimeFormat;
    /** CSV-Trennzeichen (Default `,`). */
    delimiter?: string;
    series: RestSeries[];
    /** Ort der Messung — geht als schema:Place in die Struktur. */
    place?: { name: string; latitude?: number; longitude?: number };
    /** Quellen- und Lizenzhinweis, wörtlich in den Graphen. */
    attribution: string;
    /** Mindestabstand zweier Anfragen an diese Quelle (ms). */
    minRequestIntervalMs: number;
    /** Wie lange eine Antwort wiederverwendet werden darf (ms). */
    cacheTtlMs: number;
}

const DAY_MS = 86_400_000;

/** Zeitstempel einer Quelle in Millisekunden — `null` statt geraten. */
export function parseTimestamp(raw: unknown, format: TimeFormat): number | null {
    if (raw === null || raw === undefined) return null;
    if (format === 'unix-s' || format === 'unix-ms') {
        const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
        if (!Number.isFinite(value)) return null;
        return format === 'unix-s' ? value * 1000 : value;
    }
    const text = String(raw).trim();
    if (text === '') return null;
    // Ein reines Datum ist UTC-Mitternacht. Ohne das „Z" läse es die
    // Laufzeitumgebung als Ortszeit — und dieselbe Reihe hätte auf zwei
    // Rechnern verschiedene Zeitstempel.
    const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : text;
    const parsed = Date.parse(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}

/** Zeitstempel für einen URL-Parameter. */
export function formatTimestamp(ms: number, format: TimeFormat): string {
    switch (format) {
        case 'date':
            return new Date(ms).toISOString().slice(0, 10);
        case 'unix-s':
            return String(Math.floor(ms / 1000));
        case 'unix-ms':
            return String(Math.floor(ms));
        case 'iso':
        default:
            return new Date(ms).toISOString();
    }
}

/**
 * Die Anfragen, die ein Fenster abdecken. Zerlegt wird immer — eine
 * einzige Anfrage über ein Jahr wäre für jede dieser Quellen unhöflich
 * und für die Antwortgröße riskant.
 */
export function requestUrls(mapping: RestSourceMapping, fromMs: number, toMs: number): string[] {
    if (toMs <= fromMs) return [];
    if (mapping.windowMode === 'yearly') {
        const first = new Date(fromMs).getUTCFullYear();
        const last = new Date(toMs).getUTCFullYear();
        const urls: string[] = [];
        for (let year = first; year <= last; year += 1) {
            urls.push(withQuery(mapping.url.replace('{year}', String(year)), mapping.query));
        }
        return urls;
    }
    const sliceMs = Math.max(1, mapping.windowDays) * DAY_MS;
    const urls: string[] = [];
    for (let start = fromMs; start < toMs; start += sliceMs) {
        const end = Math.min(start + sliceMs, toMs);
        const params: Record<string, string> = { ...mapping.query };
        if (mapping.fromParam) params[mapping.fromParam] = formatTimestamp(start, mapping.windowFormat);
        if (mapping.toParam) params[mapping.toParam] = formatTimestamp(end, mapping.windowFormat);
        urls.push(withQuery(mapping.url, params));
    }
    return urls;
}

function withQuery(url: string, params: Record<string, string>): string {
    const entries = Object.entries(params).filter(([, value]) => value !== '');
    if (entries.length === 0) return url;
    const separator = url.includes('?') ? '&' : '?';
    const query = entries
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
    return `${url}${separator}${query}`;
}

/** Ein Datensatz der Quelle, formatunabhängig. */
export type SourceRecord = Record<string, unknown>;

function atPath(payload: unknown, path: string | undefined): unknown {
    if (!path) return payload;
    let current: unknown = payload;
    for (const segment of path.split('.')) {
        if (current === null || typeof current !== 'object') return undefined;
        current = (current as Record<string, unknown>)[segment];
    }
    return current;
}

/**
 * CSV mit Kopfzeile → Datensätze. Bewusst schmal gehalten: getrennte
 * Felder, optionale Anführungszeichen, kein mehrzeiliges Feld. Was die
 * Kopfzeile nicht nennt, gibt es nicht — eine Spalte nach Position zu
 * raten wäre die Sorte stiller Fehler, die erst in der Schätzung auffällt.
 */
export function parseCsv(text: string, delimiter = ','): SourceRecord[] {
    const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
    if (lines.length < 2) return [];
    const header = splitCsvLine(lines[0], delimiter);
    return lines.slice(1).map(line => {
        const cells = splitCsvLine(line, delimiter);
        const record: SourceRecord = {};
        header.forEach((name, index) => {
            record[name] = cells[index] ?? '';
        });
        return record;
    });
}

function splitCsvLine(line: string, delimiter: string): string[] {
    const cells: string[] = [];
    let current = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (quoted) {
            if (char === '"') {
                if (line[index + 1] === '"') {
                    current += '"';
                    index += 1;
                } else {
                    quoted = false;
                }
            } else {
                current += char;
            }
            continue;
        }
        if (char === '"') {
            quoted = true;
            continue;
        }
        if (char === delimiter) {
            cells.push(current.trim());
            current = '';
            continue;
        }
        current += char;
    }
    cells.push(current.trim());
    return cells;
}

export interface ExtractResult {
    /** Rohpunkte je Reihenschlüssel. */
    series: Map<string, RawPoint[]>;
    /** Datensätze, die keinen brauchbaren Zeitstempel hatten. */
    unusable: number;
    /** Begründung, wenn die Antwort insgesamt nicht auswertbar war. */
    problem?: string;
}

export interface ExtractWindow {
    from: number;
    through: number;
}

/**
 * Wertet EINE Antwort für ALLE Reihen der Quelle aus. Der Zuschnitt ist
 * Absicht: Bright Sky liefert Temperatur, Wind und Strahlung in einem
 * Dokument. Je Größe erneut anzufragen wäre siebenmal dieselbe Antwort
 * für dieselbe Erfassung.
 */
export function extractSeries(
    mapping: RestSourceMapping,
    body: string,
    window: ExtractWindow,
): ExtractResult {
    const series = new Map<string, RawPoint[]>();
    for (const entry of mapping.series) series.set(entry.key, []);

    let payload: unknown;
    if (mapping.format === 'csv') {
        payload = parseCsv(body, mapping.delimiter ?? ',');
    } else {
        try {
            payload = JSON.parse(body);
        } catch (error) {
            return {
                series,
                unusable: 0,
                problem: `Antwort ist kein gültiges JSON: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }

    const data = atPath(payload, mapping.path);
    if (mapping.shape === 'columns') return extractColumns(mapping, data, series);
    if (!Array.isArray(data)) {
        return {
            series,
            unusable: 0,
            problem: mapping.path
                ? `Im Dokument gibt es unter "${mapping.path}" keine Liste von Datensätzen.`
                : 'Das Dokument ist keine Liste von Datensätzen.',
        };
    }
    const records = data.filter((entry): entry is SourceRecord =>
        entry !== null && typeof entry === 'object' && !Array.isArray(entry));
    return mapping.shape === 'intervals'
        ? extractIntervals(mapping, records, series, window)
        : extractPoints(mapping, records, series);
}

function extractPoints(
    mapping: RestSourceMapping,
    records: readonly SourceRecord[],
    series: Map<string, RawPoint[]>,
): ExtractResult {
    let unusable = 0;
    for (const record of records) {
        const t = parseTimestamp(record[mapping.timeField], mapping.timeFormat);
        if (t === null) {
            unusable += 1;
            continue;
        }
        for (const entry of mapping.series) {
            if (!matchesFilter(record, entry.filter)) continue;
            series.get(entry.key)?.push({ t, ...coerce(record[entry.field], entry) });
        }
    }
    return { series, unusable };
}

function extractColumns(
    mapping: RestSourceMapping,
    data: unknown,
    series: Map<string, RawPoint[]>,
): ExtractResult {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        return { series, unusable: 0, problem: 'Erwartet wurden parallele Spalten-Arrays.' };
    }
    const columns = data as Record<string, unknown>;
    const times = columns[mapping.timeField];
    if (!Array.isArray(times)) {
        return { series, unusable: 0, problem: `Die Zeitspalte "${mapping.timeField}" fehlt oder ist kein Array.` };
    }
    let unusable = 0;
    for (const entry of mapping.series) {
        const values = columns[entry.field];
        if (!Array.isArray(values)) continue;
        const target = series.get(entry.key);
        if (!target) continue;
        // Spalten ungleicher Länge sind kein Grund, alles zu verwerfen —
        // aber die überzähligen Zeilen sind keine Messwerte, sondern ein
        // Quellfehler, und werden als solcher gezählt.
        const length = Math.min(times.length, values.length);
        if (values.length !== times.length) unusable += Math.abs(values.length - times.length);
        for (let index = 0; index < length; index += 1) {
            const t = parseTimestamp(times[index], mapping.timeFormat);
            if (t === null) {
                unusable += 1;
                continue;
            }
            target.push({ t, ...coerce(values[index], entry) });
        }
    }
    return { series, unusable };
}

/**
 * Zeitspannen → Stufenreihe. Erzeugt wird ein Punkt am Fensteranfang
 * (Wert außerhalb), je ein Punkt am Beginn und am Ende jeder Spanne.
 * Die Verdichtung schreibt den Zustand dazwischen fort — genau wie bei
 * einem Schalter, und aus demselben Grund.
 */
function extractIntervals(
    mapping: RestSourceMapping,
    records: readonly SourceRecord[],
    series: Map<string, RawPoint[]>,
    window: ExtractWindow,
): ExtractResult {
    let unusable = 0;
    const spans: Array<{ start: number; end: number; record: SourceRecord }> = [];
    for (const record of records) {
        const start = parseTimestamp(record[mapping.timeField], mapping.timeFormat);
        if (start === null) {
            unusable += 1;
            continue;
        }
        const end = mapping.endField !== undefined
            ? parseTimestamp(record[mapping.endField], mapping.timeFormat)
            : start + (mapping.durationDays ?? 1) * DAY_MS;
        if (end === null || end <= start) {
            unusable += 1;
            continue;
        }
        spans.push({ start, end, record });
    }
    spans.sort((a, b) => a.start - b.start);

    for (const entry of mapping.series) {
        const target = series.get(entry.key);
        if (!target) continue;
        const outside: RawPoint = entry.defaultValue !== undefined
            ? { t: window.from, value: entry.defaultValue }
            : { t: window.from, value: null, gap: 'außerhalb der gemeldeten Zeitspannen' };
        target.push(outside);
        for (const span of spans) {
            if (span.end <= window.from || span.start > window.through) continue;
            if (!matchesFilter(span.record, entry.filter)) continue;
            const inside = entry.constantValue !== undefined
                ? { value: entry.constantValue }
                : coerce(span.record[entry.field], entry);
            target.push({ t: Math.max(span.start, window.from), ...inside });
            if (span.end <= window.through) {
                target.push({ ...outside, t: span.end });
            }
        }
        target.sort((a, b) => a.t - b.t);
    }
    return { series, unusable };
}

function matchesFilter(record: SourceRecord, filter: RestFilter | undefined): boolean {
    if (!filter) return true;
    const raw = record[filter.field];
    if (raw === null || raw === undefined || (Array.isArray(raw) && raw.length === 0) || raw === '') {
        return filter.whenAbsent === 'include';
    }
    if (filter.includes === undefined) return false;
    if (Array.isArray(raw)) return raw.some(value => String(value) === filter.includes);
    return String(raw) === filter.includes;
}

const TRUE_TEXTS: ReadonlySet<string> = new Set(['true', 'ja', 'yes', 'on', '1']);
const FALSE_TEXTS: ReadonlySet<string> = new Set(['false', 'nein', 'no', 'off', '0']);

/**
 * Rohwert → Messwert. Eine Lücke bleibt eine Lücke (C3): Was die Quelle
 * als `null` meldet, wird nicht durch den letzten Wert ersetzt und nicht
 * übersprungen, sondern als Lücke geführt.
 */
export function coerce(raw: unknown, entry: RestSeries): { value: number | string | null; gap?: string } {
    if (raw === null || raw === undefined || raw === '') return { value: null, gap: 'unavailable' };
    const kind: ObservationKind = entry.kind;
    if (kind === 'categorical') return { value: String(raw) };
    if (typeof raw === 'boolean') return { value: raw ? 1 : 0 };
    if (kind === 'binary' && typeof raw === 'string') {
        const lower = raw.trim().toLowerCase();
        if (TRUE_TEXTS.has(lower)) return { value: 1 };
        if (FALSE_TEXTS.has(lower)) return { value: 0 };
    }
    const numeric = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (!Number.isFinite(numeric)) return { value: null, gap: `nicht numerisch: ${String(raw).slice(0, 40)}` };
    if (kind === 'binary') return { value: numeric === 0 ? 0 : 1 };
    return { value: numeric * (entry.scale ?? 1) + (entry.offset ?? 0) };
}

/**
 * Welche Reihen die Quelle wirklich anbietet — geprüft an der **Existenz
 * des Feldes**, nicht an seinem Wert.
 *
 * Der Unterschied ist wichtig: Eine Globalstrahlung von 0 in der Nacht
 * ist ein Messwert, kein fehlendes Angebot. Würde die Verfügbarkeit an
 * vorhandenen Zahlen hängen, verschwände die Größe nachts aus der
 * Struktur und die Revision der Quelle wechselte im Tagesrhythmus.
 */
export function availableSeriesKeys(mapping: RestSourceMapping, body: string): string[] {
    // Zeitspannen-Quellen liefern ihre Reihe konstruiert (ein Wert innen,
    // einer außen) — sie ist verfügbar, sobald die Antwort auswertbar ist.
    if (mapping.shape === 'intervals') return mapping.series.map(entry => entry.key);

    let payload: unknown;
    if (mapping.format === 'csv') {
        payload = parseCsv(body, mapping.delimiter ?? ',');
    } else {
        try {
            payload = JSON.parse(body);
        } catch {
            return [];
        }
    }
    const data = atPath(payload, mapping.path);

    if (mapping.shape === 'columns') {
        if (data === null || typeof data !== 'object' || Array.isArray(data)) return [];
        const columns = data as Record<string, unknown>;
        return mapping.series.filter(entry => Array.isArray(columns[entry.field])).map(entry => entry.key);
    }
    if (!Array.isArray(data)) return [];
    const records = data.filter((entry): entry is SourceRecord =>
        entry !== null && typeof entry === 'object' && !Array.isArray(entry));
    return mapping.series
        .filter(entry => records.some(record => Object.hasOwn(record, entry.field)))
        .map(entry => entry.key);
}

/**
 * Fingerabdruck der STRUKTUR einer Quelle: Reihen, Einheiten, Ort und
 * Endpunkt. Der aktuelle Messwert gehört ausdrücklich nicht dazu — sonst
 * wäre die Revision bei jedem Lauf neu und der Import-Graph würde
 * stündlich ersetzt (dieselbe Regel wie beim Home-Assistant-Connector).
 */
export function structuralFingerprint(mapping: RestSourceMapping, availableKeys: readonly string[]): string {
    const keys = [...availableKeys].sort();
    return [
        mapping.url,
        mapping.label,
        mapping.place ? `${mapping.place.name}|${mapping.place.latitude ?? ''}|${mapping.place.longitude ?? ''}` : '',
        ...mapping.series
            .filter(entry => keys.includes(entry.key))
            .map(entry => [entry.key, entry.name, entry.kind, entry.unit ?? '', entry.observable ?? ''].join('~')),
    ].join('\n');
}
