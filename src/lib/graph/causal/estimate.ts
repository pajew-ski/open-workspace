/**
 * Die Schätzer des Tier-1-Kerns (CAUSAL_LAYER_SPEC §7, Meilenstein C4).
 *
 * Hier entsteht zum ersten Mal in diesem Layer eine **Zahl**. Sie kommt
 * spät und mit Bedingungen, und das ist Absicht (§18): Vor ihr stehen die
 * Struktur (C0), die Identifikation (C1) und die Erfassung (C3), nach ihr
 * kommt die Refutation (`refute.ts`) — ohne die sie nicht ausgegeben wird
 * (Invariante C5).
 *
 * Fünf Verfahren, alle aus der Standardliteratur, alle ohne Numerik-
 * Bibliothek und damit in allen drei Runtimes lauffähig:
 *
 *  - **Stratifikation** — der durchsichtigste Schätzer: innerhalb gleicher
 *    Störgrößen-Klassen vergleichen, dann über die Klassen mitteln.
 *  - **Regression mit Adjustierung** — kleinste Quadrate, Behandlung plus
 *    Adjustment Set; der Koeffizient der Behandlung ist der Effekt.
 *  - **IPW** — logistische Propensity, Hájek-Gewichtung. Modelliert die
 *    Behandlungszuweisung statt der Wirkung; falsch spezifiziert ist
 *    damit ein anderes Modell als bei der Regression, und genau das
 *    macht den Vergleich beider Zahlen aussagekräftig.
 *  - **Difference-in-Differences** — braucht eine Kontroll-Wirkung und
 *    einen Eingriffszeitpunkt; rechnet den gemeinsamen Trend heraus.
 *  - **Interrupted Time Series** — braucht nur den Eingriffszeitpunkt;
 *    schätzt Niveausprung und Trendbruch.
 *
 * **Konfidenz kommt aus dem Moving Block Bootstrap**, nie aus der
 * Lehrbuchformel (§15.2): Beobachtungsreihen sind autokorreliert, und ein
 * klassischer Standardfehler wäre systematisch zu klein. Ein zu enges
 * Intervall ist die gefährlichste aller Zahlen, weil es Sicherheit
 * behauptet, die niemand hat.
 *
 * Das Modul ist **pur** — kein Store, kein Netz, kein Zufall aus der
 * Umgebung.
 */

import {
    blockBootstrap,
    defaultBlockLength,
    logistic,
    logisticFit,
    mean,
    ols,
    quantile,
} from './numeric';
import type { Panel, PanelColumn } from './panel';

export const ESTIMATORS = ['stratification', 'regression', 'ipw', 'did', 'its'] as const;
export type EstimatorId = (typeof ESTIMATORS)[number];

export const ESTIMATOR_LABEL: Record<EstimatorId, string> = {
    stratification: 'Stratifikation',
    regression: 'Regression mit Adjustierung',
    ipw: 'Inverse Wahrscheinlichkeitsgewichtung (IPW)',
    did: 'Differenz von Differenzen (DiD)',
    its: 'Unterbrochene Zeitreihe (ITS)',
};

export interface EstimateSpec {
    treatment: string;
    outcome: string;
    /** Adjustment Set aus der Identifikation (C1) — nie geraten. */
    adjustedFor: readonly string[];
    estimator: EstimatorId;
    /** DiD: die Wirkung, die der Eingriff nicht getroffen haben kann. */
    controlOutcome?: string;
    /** DiD/ITS: Zeitpunkt des Eingriffs (ms seit Epoch). */
    interventionAt?: number;
    /** Klassen je stetiger Störgröße bei der Stratifikation (Default 3). */
    strata?: number;
}

export interface BootstrapOptions {
    seed: number;
    samples?: number;
    blockLength?: number;
}

export interface EffectEstimate {
    estimator: EstimatorId;
    effect: number;
    standardError: number;
    ciLow: number;
    ciHigh: number;
    rows: number;
    bootstrapSamples: number;
    blockLength: number;
    /** Was beim Rechnen aufgefallen ist — im Klartext, nie verschwiegen. */
    notes: string[];
}

export type EstimationOutcome =
    | { ok: true; estimate: EffectEstimate }
    | { ok: false; problem: string };

/** Punktschätzer über eine Auswahl von Panel-Zeilen (Bootstrap-tauglich). */
export interface PointEstimator {
    estimate(rows: readonly number[], notes?: string[]): number | null;
}

type BuildOutcome =
    | { ok: true; estimator: PointEstimator }
    | { ok: false; problem: string };

function requireColumn(panel: Panel, key: string, role: string): PanelColumn | string {
    const column = panel.column(key);
    if (!column) return `${role} steht nicht im Panel — die Größe ist nicht erfasst oder hat keine Zeile.`;
    return column;
}

function isBinaryColumn(column: PanelColumn): boolean {
    return column.values.every(value => value === 0 || value === 1);
}

/**
 * Klassengrenzen einer stetigen Störgröße. Sie werden EINMAL über das
 * ganze Panel bestimmt und in jeder Bootstrap-Ziehung wiederverwendet —
 * sonst verschöbe sich mit jeder Ziehung die Bedeutung einer Klasse, und
 * die Streuung wäre die der Klassengrenzen statt die des Effekts.
 */
function cutpointsOf(column: PanelColumn, strata: number): number[] {
    if (column.kind !== 'numeric') return [];
    const cuts: number[] = [];
    for (let index = 1; index < strata; index += 1) {
        cuts.push(quantile(column.values, index / strata));
    }
    return [...new Set(cuts)];
}

function binOf(value: number, cuts: readonly number[]): number {
    let bin = 0;
    for (const cut of cuts) {
        if (value > cut) bin += 1;
    }
    return bin;
}

function buildStratification(panel: Panel, spec: EstimateSpec): BuildOutcome {
    const treatment = requireColumn(panel, spec.treatment, 'Die Behandlung');
    if (typeof treatment === 'string') return { ok: false, problem: treatment };
    const outcome = requireColumn(panel, spec.outcome, 'Die Wirkung');
    if (typeof outcome === 'string') return { ok: false, problem: outcome };
    if (!isBinaryColumn(treatment)) {
        return {
            ok: false,
            problem: 'Stratifikation vergleicht zwei Arme und braucht deshalb eine binäre Behandlung. '
                + 'Für eine stetige Größe ist die Regression das passende Verfahren.',
        };
    }
    const covariates: Array<{ column: PanelColumn; cuts: number[] }> = [];
    for (const key of spec.adjustedFor) {
        const column = requireColumn(panel, key, `Die Störgröße „${key}"`);
        if (typeof column === 'string') return { ok: false, problem: column };
        covariates.push({ column, cuts: cutpointsOf(column, spec.strata ?? 3) });
    }

    return {
        ok: true,
        estimator: {
            estimate(rows, notes) {
                const strata = new Map<string, { treated: number[]; control: number[] }>();
                for (const row of rows) {
                    const key = covariates
                        .map(entry => binOf(entry.column.values[row], entry.cuts))
                        .join('|');
                    const bucket = strata.get(key) ?? { treated: [], control: [] };
                    (treatment.values[row] === 1 ? bucket.treated : bucket.control)
                        .push(outcome.values[row]);
                    strata.set(key, bucket);
                }
                let weighted = 0;
                let total = 0;
                let dropped = 0;
                for (const bucket of strata.values()) {
                    const size = bucket.treated.length + bucket.control.length;
                    if (bucket.treated.length === 0 || bucket.control.length === 0) {
                        dropped += size;
                        continue;
                    }
                    weighted += size * (mean(bucket.treated) - mean(bucket.control));
                    total += size;
                }
                if (total === 0) return null;
                if (notes && dropped > 0) {
                    notes.push(
                        `${dropped} von ${rows.length} Zeilen liegen in Klassen, in denen nur ein Arm `
                        + 'besetzt ist — sie tragen nichts bei (fehlender Overlap).',
                    );
                }
                if (notes) notes.push(`${strata.size} Störgrößen-Klassen gebildet.`);
                return weighted / total;
            },
        },
    };
}

function buildRegression(panel: Panel, spec: EstimateSpec): BuildOutcome {
    const treatment = requireColumn(panel, spec.treatment, 'Die Behandlung');
    if (typeof treatment === 'string') return { ok: false, problem: treatment };
    const outcome = requireColumn(panel, spec.outcome, 'Die Wirkung');
    if (typeof outcome === 'string') return { ok: false, problem: outcome };
    const covariates: PanelColumn[] = [];
    for (const key of spec.adjustedFor) {
        const column = requireColumn(panel, key, `Die Störgröße „${key}"`);
        if (typeof column === 'string') return { ok: false, problem: column };
        covariates.push(column);
    }
    return {
        ok: true,
        estimator: {
            estimate(rows) {
                const design = rows.map(row => [
                    1,
                    treatment.values[row],
                    ...covariates.map(column => column.values[row]),
                ]);
                const y = rows.map(row => outcome.values[row]);
                const fit = ols(design, y);
                return fit ? fit.coefficients[1] : null;
            },
        },
    };
}

/** Grenzen, in die eine Propensity beschnitten wird (Overlap-Schutz). */
const PROPENSITY_BOUNDS = { low: 0.02, high: 0.98 } as const;

function buildIpw(panel: Panel, spec: EstimateSpec): BuildOutcome {
    const treatment = requireColumn(panel, spec.treatment, 'Die Behandlung');
    if (typeof treatment === 'string') return { ok: false, problem: treatment };
    const outcome = requireColumn(panel, spec.outcome, 'Die Wirkung');
    if (typeof outcome === 'string') return { ok: false, problem: outcome };
    if (!isBinaryColumn(treatment)) {
        return {
            ok: false,
            problem: 'IPW modelliert die Wahrscheinlichkeit, behandelt zu werden, und braucht dafür '
                + 'eine binäre Behandlung.',
        };
    }
    const covariates: PanelColumn[] = [];
    for (const key of spec.adjustedFor) {
        const column = requireColumn(panel, key, `Die Störgröße „${key}"`);
        if (typeof column === 'string') return { ok: false, problem: column };
        covariates.push(column);
    }
    return {
        ok: true,
        estimator: {
            estimate(rows, notes) {
                const design = rows.map(row => [1, ...covariates.map(column => column.values[row])]);
                const t = rows.map(row => treatment.values[row]);
                const beta = logisticFit(design, t);
                if (!beta) return null;
                let treatedValue = 0;
                let treatedWeight = 0;
                let controlValue = 0;
                let controlWeight = 0;
                let clipped = 0;
                rows.forEach((row, index) => {
                    const raw = logistic(design[index], beta);
                    const propensity = Math.min(PROPENSITY_BOUNDS.high, Math.max(PROPENSITY_BOUNDS.low, raw));
                    if (propensity !== raw) clipped += 1;
                    if (t[index] === 1) {
                        const weight = 1 / propensity;
                        treatedValue += weight * outcome.values[row];
                        treatedWeight += weight;
                    } else {
                        const weight = 1 / (1 - propensity);
                        controlValue += weight * outcome.values[row];
                        controlWeight += weight;
                    }
                });
                if (treatedWeight === 0 || controlWeight === 0) return null;
                if (notes && clipped > 0) {
                    notes.push(
                        `${clipped} von ${rows.length} Propensity-Werten lagen außerhalb von `
                        + `[${PROPENSITY_BOUNDS.low}, ${PROPENSITY_BOUNDS.high}] und wurden beschnitten — `
                        + 'für diese Zeilen ist der Overlap dünn.',
                    );
                }
                return treatedValue / treatedWeight - controlValue / controlWeight;
            },
        },
    };
}

function buildDid(panel: Panel, spec: EstimateSpec): BuildOutcome {
    if (spec.interventionAt === undefined) {
        return { ok: false, problem: 'Difference-in-Differences braucht den Zeitpunkt des Eingriffs.' };
    }
    if (!spec.controlOutcome) {
        return {
            ok: false,
            problem: 'Difference-in-Differences braucht eine Kontroll-Wirkung: eine Größe, die derselbe '
                + 'Trend trifft, der Eingriff aber nicht.',
        };
    }
    const outcome = requireColumn(panel, spec.outcome, 'Die Wirkung');
    if (typeof outcome === 'string') return { ok: false, problem: outcome };
    const control = requireColumn(panel, spec.controlOutcome, 'Die Kontroll-Wirkung');
    if (typeof control === 'string') return { ok: false, problem: control };
    const intervention = spec.interventionAt;

    return {
        ok: true,
        estimator: {
            estimate(rows, notes) {
                const treatedPre: number[] = [];
                const treatedPost: number[] = [];
                const controlPre: number[] = [];
                const controlPost: number[] = [];
                for (const row of rows) {
                    const post = panel.timestamps[row] >= intervention;
                    (post ? treatedPost : treatedPre).push(outcome.values[row]);
                    (post ? controlPost : controlPre).push(control.values[row]);
                }
                if (treatedPre.length === 0 || treatedPost.length === 0) return null;
                if (notes) {
                    notes.push(`${treatedPre.length} Zeilen vor, ${treatedPost.length} nach dem Eingriff.`);
                }
                return (mean(treatedPost) - mean(treatedPre)) - (mean(controlPost) - mean(controlPre));
            },
        },
    };
}

function buildIts(panel: Panel, spec: EstimateSpec): BuildOutcome {
    if (spec.interventionAt === undefined) {
        return { ok: false, problem: 'Die unterbrochene Zeitreihe braucht den Zeitpunkt des Eingriffs.' };
    }
    const outcome = requireColumn(panel, spec.outcome, 'Die Wirkung');
    if (typeof outcome === 'string') return { ok: false, problem: outcome };
    const intervention = spec.interventionAt;
    const step = Math.max(panel.intervalSeconds, 1) * 1000;
    const origin = panel.timestamps[0] ?? intervention;

    return {
        ok: true,
        estimator: {
            estimate(rows, notes) {
                let pre = 0;
                let post = 0;
                const design = rows.map(row => {
                    const at = panel.timestamps[row];
                    const time = (at - origin) / step;
                    const after = at >= intervention ? 1 : 0;
                    if (after === 1) post += 1; else pre += 1;
                    const since = after === 1 ? (at - intervention) / step : 0;
                    return [1, time, after, since];
                });
                if (pre < 3 || post < 3) return null;
                const fit = ols(design, rows.map(row => outcome.values[row]));
                if (!fit) return null;
                if (notes) {
                    notes.push(
                        `Niveausprung am Eingriff; der Trendbruch beträgt ${fit.coefficients[3].toFixed(4)} `
                        + 'je Rasterschritt und steht nicht im ausgewiesenen Effekt.',
                    );
                    notes.push(`${pre} Zeilen vor, ${post} nach dem Eingriff.`);
                }
                return fit.coefficients[2];
            },
        },
    };
}

/** Baut den Punktschätzer eines Verfahrens — oder sagt, warum nicht. */
export function buildEstimator(panel: Panel, spec: EstimateSpec): BuildOutcome {
    switch (spec.estimator) {
        case 'stratification': return buildStratification(panel, spec);
        case 'regression': return buildRegression(panel, spec);
        case 'ipw': return buildIpw(panel, spec);
        case 'did': return buildDid(panel, spec);
        case 'its': return buildIts(panel, spec);
    }
}

/**
 * Wählt das Verfahren, wenn der Mensch keines vorgegeben hat. Die Regel
 * ist bewusst schlicht und steht in der Studie (C7) — ein Automatismus,
 * den niemand nachlesen kann, wäre schlimmer als eine feste Wahl.
 */
export function chooseEstimator(
    panel: Panel,
    spec: Pick<EstimateSpec, 'treatment' | 'controlOutcome' | 'interventionAt'>,
): EstimatorId {
    if (spec.interventionAt !== undefined) return spec.controlOutcome ? 'did' : 'its';
    const treatment = panel.column(spec.treatment);
    if (treatment && isBinaryColumn(treatment)) return 'ipw';
    return 'regression';
}

/** Voreinstellung der Bootstrap-Ziehungen — Teil der Studien-Signatur (C7). */
export const DEFAULT_BOOTSTRAP_SAMPLES = 200;

/**
 * Punktschätzung plus Konfidenzintervall. Ein Ergebnis entsteht nur, wenn
 * beides da ist: Eine Zahl ohne Intervall wäre in diesem Layer die
 * Scheinpräzision, gegen die §2.2 argumentiert.
 */
export function estimateEffect(
    panel: Panel,
    spec: EstimateSpec,
    options: BootstrapOptions,
): EstimationOutcome {
    const built = buildEstimator(panel, spec);
    if (!built.ok) return { ok: false, problem: built.problem };

    const rows = panel.timestamps.map((_, index) => index);
    const notes: string[] = [];
    const point = built.estimator.estimate(rows, notes);
    if (point === null || !Number.isFinite(point)) {
        return {
            ok: false,
            problem: 'Das Verfahren liefert für diese Datenlage keinen Wert — '
                + 'meist fehlt Variation in der Behandlung oder die Störgrößen sind kollinear.',
        };
    }

    const blockLength = options.blockLength ?? defaultBlockLength(rows.length);
    const samples = options.samples ?? DEFAULT_BOOTSTRAP_SAMPLES;
    const interval = blockBootstrap(
        rows.length,
        sample => built.estimator.estimate(sample),
        { seed: options.seed, samples, blockLength },
    );
    if (!interval) {
        return {
            ok: false,
            problem: 'Für ein Konfidenzintervall reichen die Daten nicht: Zu viele Bootstrap-Ziehungen '
                + 'lieferten kein Ergebnis. Eine Punktschätzung ohne Intervall wird nicht ausgegeben.',
        };
    }

    return {
        ok: true,
        estimate: {
            estimator: spec.estimator,
            effect: point,
            standardError: interval.standardError,
            ciLow: interval.ciLow,
            ciHigh: interval.ciHigh,
            rows: rows.length,
            bootstrapSamples: interval.samples,
            blockLength,
            notes,
        },
    };
}
