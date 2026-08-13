/**
 * Das Studien-Panel: aus Messreihen wird eine Tabelle
 * (CAUSAL_LAYER_SPEC §6, Meilenstein C4).
 *
 * Ein Schätzer sieht keine Zeitreihen, sondern Zeilen: zu jedem Zeitpunkt
 * ein Wert je Größe. Genau diese Umformung passiert hier — und sie ist der
 * Ort, an dem die meisten stillen Fehler entstehen würden, wenn man sie
 * nicht benennt:
 *
 *  - **Das Raster ist das gröbste der beteiligten Reihen.** Wer eine
 *    Fünf-Minuten-Reihe auf ein Minutenraster hebt, erfindet vier von fünf
 *    Werten. Verdichten ist zulässig, Verfeinern nicht.
 *  - **Eine Lücke kippt die ganze Zeile.** Fehlt eine Größe, fällt der
 *    Zeitpunkt heraus (listenweiser Ausschluss) — und wird gezählt, je
 *    Größe. Fehlende Werte sind selten zufällig fehlend (§15.4); wer sie
 *    interpoliert, verzerrt unsichtbar. Was hier verschwindet, steht
 *    hinterher in der Studie.
 *  - **Der Zeitversatz einer Kante wird angewendet, nicht bloß
 *    angezeigt.** Trägt eine Kante `ow:temporalLag PT15M`, wird die
 *    Ursache 15 Minuten früher gelesen. Ohne das wäre die Ursache mit
 *    ihrer eigenen Wirkung im selben Intervall — und die Schätzung
 *    beantwortete eine andere Frage als die gestellte.
 *  - **Der Bestand hält an, aber nur so weit er reicht.** Ein Wert gilt
 *    bis zum nächsten Rasterpunkt seiner eigenen Reihe; danach ist er
 *    keine Auskunft mehr, sondern eine Vermutung. Verdichtet wurde schon
 *    bei der Erfassung (C3), hier wird nur noch zugeordnet.
 *
 * Das Modul ist **pur** — dieselbe Eingabe, dasselbe Panel (Invariante C7).
 */

import type { Observation, ObservationKind } from '../observations/types';

export interface PanelSeries {
    /** Schlüssel der Spalte — im Produktivpfad die Variablen-IRI. */
    key: string;
    kind: ObservationKind;
    /** Abtastabstand der Reihe in Sekunden (aus der Erfassungsregel). */
    intervalSeconds: number;
    observations: readonly Observation[];
    /**
     * Zeitversatz in Sekunden: Der Wert dieser Spalte wird um so viel
     * früher gelesen (die Ursache wirkt verzögert).
     */
    lagSeconds?: number;
    unit?: string;
}

export interface PanelOptions {
    /** Untere Fenstergrenze (inklusiv, ms seit Epoch). */
    from?: number;
    /** Obere Fenstergrenze (inklusiv, ms seit Epoch). */
    through?: number;
    /** Raster in Sekunden; ohne Angabe der gröbste Abstand der Reihen. */
    intervalSeconds?: number;
    /** Harte Obergrenze an Zeilen; gekappt wird am ÄLTEREN Ende. */
    maxRows?: number;
}

export interface PanelColumn {
    key: string;
    kind: ObservationKind;
    /** Kodierte Werte, eine je Panel-Zeile. */
    values: number[];
    /** Kodierung kategorialer Größen, quelltreu und in Fundreihenfolge. */
    levels?: string[];
    unit?: string;
    lagSeconds: number;
    /** Zeilen, die wegen dieser Größe entfallen sind. */
    droppedRows: number;
}

export interface Panel {
    timestamps: number[];
    columns: PanelColumn[];
    rows: number;
    intervalSeconds: number;
    from?: number;
    through?: number;
    /** Rasterpunkte insgesamt, bevor Lücken Zeilen gestrichen haben. */
    candidateRows: number;
    /** true, wenn `maxRows` gegriffen hat — dann fehlt der ältere Rand. */
    truncated: boolean;
    /** Warum kein Panel entstanden ist; leer, wenn eines entstand. */
    problem?: string;
    column(key: string): PanelColumn | undefined;
}

const TRUE_STATES = new Set(['on', 'true', '1', 'yes', 'open', 'home', 'detected', 'unlocked', 'heat']);
const FALSE_STATES = new Set(['off', 'false', '0', 'no', 'closed', 'not_home', 'clear', 'locked', 'idle']);

/**
 * Ein Messwert wird zur Zahl — oder zu `null`, wenn er keine ist. Ein
 * unbekannter Schalterzustand wird NICHT auf 0 geraten: Das wäre eine
 * erfundene Beobachtung, und sie sähe von außen aus wie eine gemessene.
 */
export function encodeValue(
    value: number | string | null,
    kind: ObservationKind,
    levels: readonly string[],
): number | null {
    if (value === null) return null;
    if (kind === 'categorical') {
        const index = levels.indexOf(String(value));
        return index >= 0 ? index : null;
    }
    if (kind === 'binary') {
        if (typeof value === 'number') return Number.isFinite(value) ? (value !== 0 ? 1 : 0) : null;
        const normalized = value.trim().toLowerCase();
        if (TRUE_STATES.has(normalized)) return 1;
        if (FALSE_STATES.has(normalized)) return 0;
        const parsed = Number(normalized);
        return Number.isFinite(parsed) ? (parsed !== 0 ? 1 : 0) : null;
    }
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

/** Die Stufen einer kategorialen Reihe in Fundreihenfolge (deterministisch). */
export function levelsOf(observations: readonly Observation[]): string[] {
    const levels: string[] = [];
    for (const point of [...observations].sort((a, b) => a.t - b.t)) {
        if (point.v === null) continue;
        const value = String(point.v);
        if (!levels.includes(value)) levels.push(value);
    }
    return levels;
}

interface PreparedSeries {
    series: PanelSeries;
    levels: string[];
    /** Aufsteigend nach Zeit, kodiert; `null` markiert eine Lücke. */
    points: Array<{ t: number; v: number | null }>;
    lagMs: number;
    toleranceMs: number;
}

function prepare(series: PanelSeries): PreparedSeries {
    const levels = series.kind === 'categorical' ? levelsOf(series.observations) : [];
    const points = [...series.observations]
        .sort((a, b) => a.t - b.t)
        .map(point => ({ t: point.t, v: encodeValue(point.v, series.kind, levels) }));
    return {
        series,
        levels,
        points,
        lagMs: (series.lagSeconds ?? 0) * 1000,
        // Ein Wert gilt bis zum nächsten Rasterpunkt seiner eigenen Reihe.
        // Danach hat die Reihe nichts mehr gesagt — und Schweigen ist keine
        // Messung.
        toleranceMs: Math.max(series.intervalSeconds, 1) * 1000,
    };
}

/** Letzter Wert bei oder vor `at`, sofern er noch gilt; sonst `null`. */
function valueAt(prepared: PreparedSeries, at: number): number | null {
    const { points, toleranceMs } = prepared;
    let low = 0;
    let high = points.length - 1;
    let found = -1;
    while (low <= high) {
        const middle = (low + high) >> 1;
        if (points[middle].t <= at) {
            found = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    if (found < 0) return null;
    const point = points[found];
    if (at - point.t >= toleranceMs) return null;
    return point.v;
}

function emptyPanel(intervalSeconds: number, problem: string): Panel {
    return {
        timestamps: [],
        columns: [],
        rows: 0,
        intervalSeconds,
        candidateRows: 0,
        truncated: false,
        problem,
        column: () => undefined,
    };
}

/**
 * Baut das Panel. Ergebnis ist entweder eine Tabelle mit mindestens einer
 * Zeile oder ein `problem` im Klartext — nie eine Tabelle, deren Zustand
 * man raten muss.
 */
export function buildPanel(series: readonly PanelSeries[], options: PanelOptions = {}): Panel {
    if (series.length === 0) return emptyPanel(0, 'Ohne Größen entsteht kein Panel.');

    const intervalSeconds = options.intervalSeconds
        ?? Math.max(...series.map(entry => Math.max(entry.intervalSeconds, 1)));
    const step = intervalSeconds * 1000;
    const prepared = series.map(prepare);

    const missing = prepared.filter(entry => entry.points.length === 0);
    if (missing.length > 0) {
        return emptyPanel(
            intervalSeconds,
            `Für ${missing.map(entry => entry.series.key).join(', ')} liegt keine einzige Beobachtung vor.`,
        );
    }

    // Fenster: der Schnitt aller Reihen, jeweils um ihren Zeitversatz
    // verschoben. Wer eine Ursache 15 Minuten früher liest, braucht sie
    // auch 15 Minuten früher erfasst.
    let start = Number.NEGATIVE_INFINITY;
    let end = Number.POSITIVE_INFINITY;
    for (const entry of prepared) {
        start = Math.max(start, entry.points[0].t + entry.lagMs);
        end = Math.min(end, entry.points[entry.points.length - 1].t + entry.lagMs + entry.toleranceMs - 1);
    }
    if (options.from !== undefined) start = Math.max(start, options.from);
    if (options.through !== undefined) end = Math.min(end, options.through);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        return emptyPanel(
            intervalSeconds,
            'Die Reihen überlappen sich zeitlich nicht — es gibt keinen Zeitpunkt, '
            + 'an dem alle beteiligten Größen erfasst waren.',
        );
    }

    const firstBucket = Math.ceil(start / step) * step;
    const lastBucket = Math.floor(end / step) * step;
    if (lastBucket < firstBucket) {
        return emptyPanel(intervalSeconds, 'Das gemeinsame Fenster ist kürzer als ein Rasterschritt.');
    }

    const candidateRows = Math.floor((lastBucket - firstBucket) / step) + 1;
    const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;
    const truncated = candidateRows > maxRows;
    // Gekappt wird am älteren Ende: Die jüngeren Beobachtungen sind die,
    // über die jemand tatsächlich eine Frage hat.
    const gridStart = truncated ? lastBucket - (maxRows - 1) * step : firstBucket;

    const timestamps: number[] = [];
    const values = prepared.map(() => [] as number[]);
    const dropped = prepared.map(() => 0);

    for (let at = gridStart; at <= lastBucket; at += step) {
        const row = prepared.map(entry => valueAt(entry, at - entry.lagMs));
        const gaps = row.map((value, index) => (value === null ? index : -1)).filter(index => index >= 0);
        if (gaps.length > 0) {
            for (const index of gaps) dropped[index] += 1;
            continue;
        }
        timestamps.push(at);
        row.forEach((value, index) => values[index].push(value as number));
    }

    const columns: PanelColumn[] = prepared.map((entry, index) => ({
        key: entry.series.key,
        kind: entry.series.kind,
        values: values[index],
        ...(entry.levels.length > 0 ? { levels: entry.levels } : {}),
        ...(entry.series.unit ? { unit: entry.series.unit } : {}),
        lagSeconds: entry.series.lagSeconds ?? 0,
        droppedRows: dropped[index],
    }));

    const byKey = new Map(columns.map(column => [column.key, column]));
    const rows = timestamps.length;
    return {
        timestamps,
        columns,
        rows,
        intervalSeconds,
        ...(rows > 0 ? { from: timestamps[0], through: timestamps[rows - 1] } : {}),
        candidateRows: truncated ? Math.min(candidateRows, maxRows) : candidateRows,
        truncated,
        ...(rows === 0
            ? {
                problem: 'Kein Zeitpunkt, an dem alle beteiligten Größen einen Wert hatten — '
                    + 'jede Zeile ist an einer Lücke gescheitert.',
            }
            : {}),
        column: key => byKey.get(key),
    };
}

/**
 * Panel mit ersetzten oder ergänzten Spalten — die Grundlage der
 * Refutationen (`refute.ts`): Ein Placebo tauscht die Behandlung aus, eine
 * zufällige gemeinsame Ursache kommt hinzu. Zeitstempel und Zeilenzahl
 * bleiben, damit beide Rechnungen dieselbe Datenlage sehen und der
 * Vergleich etwas bedeutet.
 */
export function withColumns(panel: Panel, replacements: readonly PanelColumn[]): Panel {
    const columns = [...panel.columns];
    for (const replacement of replacements) {
        const index = columns.findIndex(column => column.key === replacement.key);
        if (index >= 0) columns[index] = replacement;
        else columns.push(replacement);
    }
    const byKey = new Map(columns.map(column => [column.key, column]));
    return { ...panel, columns, column: key => byKey.get(key) };
}

export interface PositivityReport {
    /** Hat die Behandlung überhaupt variiert? */
    varies: boolean;
    /** Bei binärer Behandlung: Zeilen je Arm. */
    treated?: number;
    control?: number;
    /** Klartext, immer gesetzt. */
    reason: string;
}

/**
 * Positivität (§15.3): Ohne Varianz in der Behandlung ist kein Effekt
 * schätzbar — egal wie lang die Reihe ist. Ein Thermostat, das immer auf
 * 21° steht, hat keinen messbaren Effekt, und das ist keine Schwäche des
 * Verfahrens, sondern die Lage. Sie wird deshalb geprüft und berichtet,
 * nicht stillschweigend umgangen.
 */
export function checkPositivity(column: PanelColumn | undefined, minimumPerArm = 5): PositivityReport {
    if (!column || column.values.length === 0) {
        return { varies: false, reason: 'Für die Behandlung liegt keine einzige Zeile vor.' };
    }
    const distinct = new Set(column.values);
    if (distinct.size < 2) {
        return {
            varies: false,
            reason: 'Die Behandlung ist im gesamten Fenster konstant — ohne Variation lässt sich '
                + 'ihr Effekt nicht schätzen (Positivität).',
        };
    }
    if (column.kind === 'binary') {
        const treated = column.values.filter(value => value === 1).length;
        const control = column.values.length - treated;
        if (treated < minimumPerArm || control < minimumPerArm) {
            return {
                varies: false,
                treated,
                control,
                reason: `Ein Arm ist zu dünn besetzt (${treated} mit, ${control} ohne Behandlung; `
                    + `nötig sind je ${minimumPerArm}).`,
            };
        }
        return { varies: true, treated, control, reason: `${treated} Zeilen mit, ${control} ohne Behandlung.` };
    }
    return { varies: true, reason: `Die Behandlung nimmt ${distinct.size} verschiedene Werte an.` };
}
