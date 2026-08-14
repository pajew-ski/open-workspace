/**
 * Eine Studie: von der Frage zur Zahl — oder zur Begründung, warum es
 * keine gibt (CAUSAL_LAYER_SPEC §13, Meilenstein C4).
 *
 * Dieses Modul führt zusammen, was die vorigen Meilensteine getrennt
 * gebaut haben, und hält dabei die Reihenfolge ein, die den ganzen Layer
 * trägt:
 *
 *   Struktur (C0) → Identifikation (C1) → Panel (C3) → Schätzung →
 *   Refutation → Urteil
 *
 * Vier Ausgänge, und drei davon sind **keine** Zahl:
 *
 *  - `not-identifiable` — der DAG gibt die Frage nicht her, oder eine
 *    nötige Größe wird nicht erfasst. Das ist ein wertvolles Ergebnis (§7)
 *    und wird als solches ausgegeben, mit dem Namen der fehlenden Größe.
 *  - `not-estimable` — identifizierbar, aber die Datenlage trägt nicht:
 *    keine Variation in der Behandlung (§15.3), keine gemeinsamen Zeilen,
 *    kollineare Störgrößen, oder eine Strategie, für die Tier 1 keinen
 *    Schätzer hat (Frontdoor, Instrument). Keine Attrappe, keine Zahl.
 *  - `refuted` — geschätzt und durchgefallen. Der Wert wird **nicht**
 *    ausgegeben (Invariante C5); der durchgefallene Versuch schon.
 *  - `passed` — geschätzt und allen blockierenden Refutationen
 *    standgehalten. Erst hier gibt es einen Effekt.
 *
 * Das Modul ist **pur**: Es bekommt Modell und Reihen übergeben und gibt
 * ein Ergebnis zurück. Store, Dateien und Netz liegen in
 * `study-run.server.ts`; nur so läuft die Rechnung auch im Browser
 * (Invariante C9).
 */

import type { Aggregation } from '../observations/types';
import { descendants } from './dag';
import {
    chooseEstimator,
    estimateEffect,
    ESTIMATORS,
    type EffectEstimate,
    type EstimateSpec,
    type EstimatorId,
} from './estimate';
import { identifyEffect, type IdentificationResult } from './identify';
import { buildPanel, checkPositivity, type Panel, type PanelSeries, type PositivityReport } from './panel';
import { refutationPassed, runRefutations, type RefutationResult } from './refute';
import type { CausalModelView } from './types';
import { dagFromModel } from './view';

export const STUDY_VERDICTS = ['not-identifiable', 'not-estimable', 'refuted', 'passed'] as const;
export type StudyVerdict = (typeof STUDY_VERDICTS)[number];

export const STUDY_VERDICT_LABEL: Record<StudyVerdict, string> = {
    'not-identifiable': 'nicht identifizierbar',
    'not-estimable': 'nicht schätzbar',
    refuted: 'durchgefallen',
    passed: 'refutiert bestanden',
};

/** Wahl des Verfahrens: fest gesetzt oder nach der Regel in `estimate.ts`. */
export type EstimatorChoice = EstimatorId | 'auto';

export const ESTIMATOR_CHOICES = ['auto', ...ESTIMATORS] as const;

export interface StudySpec {
    /** Kennung der Frage (Estimand) — sie überlebt den Lauf. */
    id: string;
    treatment: string;
    outcome: string;
    estimator: EstimatorChoice;
    /** Gesetzter Zufall — ohne ihn wäre keine Studie reproduzierbar (C7). */
    seed: number;
    /** DiD: die Wirkung, die der Eingriff nicht getroffen haben kann. */
    controlOutcome?: string;
    /** DiD/ITS: Zeitpunkt des Eingriffs (ms seit Epoch). */
    interventionAt?: number;
    /** Datenfenster (ms seit Epoch), beide inklusiv. */
    windowFrom?: number;
    windowThrough?: number;
}

/** Eine Reihe samt der Angaben, die in die Signatur der Studie gehören. */
export interface StudySeries extends PanelSeries {
    name?: string;
    aggregation?: Aggregation;
}

export interface StudyInput {
    spec: StudySpec;
    model: CausalModelView;
    /** Reihen aller ERFASSTEN Modellgrößen (C3), Schlüssel = Variablen-IRI. */
    series: readonly StudySeries[];
    bootstrapSamples?: number;
    /** Obergrenze an Panel-Zeilen; gekappt wird am älteren Ende. */
    maxRows?: number;
}

/** Was aus einer Größe in die Studie eingegangen ist (Signatur, C7). */
export interface StudyDatasetInput {
    variable: string;
    name?: string;
    role: 'treatment' | 'outcome' | 'adjustment' | 'control-outcome';
    /** Verwendeter Zeitversatz in Sekunden. */
    lagSeconds: number;
    intervalSeconds: number;
    aggregation?: Aggregation;
    /** Beobachtungen der Reihe im Fenster, vor dem Zeilenabgleich. */
    observationCount: number;
    /** Zeilen, die wegen dieser Größe entfallen sind. */
    droppedRows: number;
}

export interface StudyDataset {
    rows: number;
    intervalSeconds: number;
    from?: number;
    through?: number;
    truncated: boolean;
    inputs: StudyDatasetInput[];
}

export interface StudyResult {
    spec: StudySpec;
    modelIri: string;
    modelGraph: string;
    /** Revision, auf die sich die Studie beruft (C7). */
    modelRevision: number;
    verdict: StudyVerdict;
    identification: IdentificationResult;
    /** Tatsächlich angewandte Adjustierung — leer heißt: keine angewandt. */
    adjustedFor: string[];
    estimator?: EstimatorId;
    /** Nur bei `passed` gesetzt: der Effekt, den man zitieren darf (C5). */
    effect?: EffectEstimate;
    /**
     * Die geschätzte Zahl VOR der Refutation. Sie steht hier für die
     * Erklärung im Fehlerfall und wird nie als Effekt geschrieben — genau
     * das verlangt Invariante C5.
     */
    rawEstimate?: EffectEstimate;
    refutations: RefutationResult[];
    positivity?: PositivityReport;
    dataset?: StudyDataset;
    /** Einheit der Wirkung, quelltreu aus der Erfassung. */
    outcomeUnit?: string;
    /** Warum es so ausging — immer gesetzt, immer deutsch. */
    reason: string;
}

function seriesByKey(series: readonly StudySeries[]): Map<string, StudySeries> {
    return new Map(series.map(entry => [entry.key, entry]));
}

/**
 * Zeitversatz der Behandlung: der Versatz der **direkten** Kante von
 * Behandlung auf Wirkung, sonst keiner. Summen über Zwischenschritte
 * wären eine Erfindung — welcher Weg gemeint ist, weiß nur der Mensch,
 * und er kann es an der Kante hinterlegen.
 */
export function treatmentLagSeconds(model: CausalModelView, treatment: string, outcome: string): number {
    const edge = model.edges.find(candidate => candidate.from === treatment && candidate.to === outcome);
    if (!edge?.temporalLag) return 0;
    return isoDurationSeconds(edge.temporalLag) ?? 0;
}

/** `PT15M` → 900. Nur die Formen, die der Editor schreibt; sonst `null`. */
export function isoDurationSeconds(value: string): number | null {
    const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
    if (!match || match.slice(1).every(part => part === undefined)) return null;
    return Number(match[1] ?? 0) * 86400
        + Number(match[2] ?? 0) * 3600
        + Number(match[3] ?? 0) * 60
        + Number(match[4] ?? 0);
}

function failed(
    base: Omit<StudyResult, 'verdict' | 'reason' | 'refutations' | 'adjustedFor'>,
    verdict: StudyVerdict,
    reason: string,
    extra: Partial<StudyResult> = {},
): StudyResult {
    return { ...base, verdict, reason, refutations: [], adjustedFor: [], ...extra };
}

/**
 * Führt eine Studie durch. Der Rückgabewert ist vollständig: Er trägt das
 * Urteil, die Begründung, die Identifikation, das Datenfenster und jeden
 * Refutationsversuch — auch wenn nie eine Zahl entstanden ist.
 */
export function runStudy(input: StudyInput): StudyResult {
    const { spec, model } = input;
    const { dag, observable, label } = dagFromModel(model);
    const available = seriesByKey(input.series);

    // Beobachtbar heißt erfasst (C3) — und für eine Schätzung heißt es
    // zusätzlich: Es liegt wirklich eine Reihe vor. Eine Größe mit
    // Erfassungsregel, aber ohne einen einzigen Messpunkt, kann keine
    // Adjustierung tragen, und die Identifikation soll das sagen, statt
    // eine Menge vorzuschlagen, die niemand rechnen kann.
    const usable = new Set([...observable].filter(node => available.has(node)));
    const identification = identifyEffect(dag, spec.treatment, spec.outcome, { observable: usable, label });

    const base = {
        spec,
        modelIri: model.iri,
        modelGraph: model.graph,
        modelRevision: model.revision,
        identification,
    };

    if (!identification.identifiable) {
        return failed(base, 'not-identifiable', identification.reason);
    }
    if (identification.zeroEffect) {
        return failed(base, 'not-estimable', identification.reason);
    }
    if (identification.strategy !== 'backdoor') {
        return failed(
            base,
            'not-estimable',
            `${identification.reason} Für diese Strategie hat der Tier-1-Kern noch keinen Schätzer — `
            + 'Frontdoor und Instrumentvariablen sind identifiziert, aber nicht gerechnet. '
            + 'Eine Zahl, die so täte, gäbe es hier nicht.',
        );
    }

    const adjustment = identification.adjustmentSets[0] ?? [];
    const timeDesign = spec.interventionAt !== undefined;
    const required: Array<{ key: string; role: StudyDatasetInput['role'] }> = [
        { key: spec.treatment, role: 'treatment' },
        { key: spec.outcome, role: 'outcome' },
        ...(timeDesign ? [] : adjustment.map(key => ({ key, role: 'adjustment' as const }))),
        ...(spec.controlOutcome ? [{ key: spec.controlOutcome, role: 'control-outcome' as const }] : []),
    ];
    const missing = required.filter(entry => !available.has(entry.key));
    if (missing.length > 0) {
        return failed(
            base,
            'not-estimable',
            `Für ${missing.map(entry => label(entry.key)).join(', ')} liegt keine Messreihe vor. `
            + 'Ohne Reihe gibt es keine Spalte, und ohne Spalte keine Schätzung.',
        );
    }

    const lag = treatmentLagSeconds(model, spec.treatment, spec.outcome);
    const panelSeries: PanelSeries[] = required.map(entry => {
        const series = available.get(entry.key) as StudySeries;
        return {
            ...series,
            ...(entry.role === 'treatment' && lag > 0 ? { lagSeconds: lag } : {}),
        };
    });
    const panel = buildPanel(panelSeries, {
        ...(spec.windowFrom !== undefined ? { from: spec.windowFrom } : {}),
        ...(spec.windowThrough !== undefined ? { through: spec.windowThrough } : {}),
        ...(input.maxRows !== undefined ? { maxRows: input.maxRows } : {}),
    });
    if (panel.rows === 0) {
        return failed(base, 'not-estimable', panel.problem ?? 'Es entstand kein Panel.');
    }

    const estimator: EstimatorId = spec.estimator === 'auto'
        ? chooseEstimator(panel, {
            treatment: spec.treatment,
            ...(spec.controlOutcome ? { controlOutcome: spec.controlOutcome } : {}),
            ...(spec.interventionAt !== undefined ? { interventionAt: spec.interventionAt } : {}),
        })
        : spec.estimator;

    const dataset = describeDataset(panel, required, available, lag);
    const outcomeUnit = available.get(spec.outcome)?.unit;

    // Positivität (§15.3) gilt für die Verfahren, die zwei Arme
    // vergleichen. DiD und ITS trennen nach Zeit statt nach Arm — dort
    // wäre die Prüfung eine andere Frage und wird nicht vorgetäuscht.
    const comparesArms = estimator === 'stratification' || estimator === 'ipw' || estimator === 'regression';
    const positivity = comparesArms ? checkPositivity(panel.column(spec.treatment)) : undefined;
    if (positivity && !positivity.varies) {
        return failed(base, 'not-estimable', positivity.reason, {
            positivity,
            dataset,
            ...(outcomeUnit ? { outcomeUnit } : {}),
        });
    }

    const estimateSpec: EstimateSpec = {
        treatment: spec.treatment,
        outcome: spec.outcome,
        // DiD und ITS rechnen den Störfaktor über die Zeit heraus, nicht
        // über eine Adjustierung. Eine Adjustierung zu protokollieren, die
        // niemand angewandt hat, wäre eine falsche Signatur (C7).
        adjustedFor: timeDesign ? [] : adjustment,
        estimator,
        ...(spec.controlOutcome ? { controlOutcome: spec.controlOutcome } : {}),
        ...(spec.interventionAt !== undefined ? { interventionAt: spec.interventionAt } : {}),
    };
    const outcome = estimateEffect(panel, estimateSpec, {
        seed: spec.seed,
        ...(input.bootstrapSamples !== undefined ? { samples: input.bootstrapSamples } : {}),
    });
    if (!outcome.ok) {
        return failed(base, 'not-estimable', outcome.problem, {
            estimator,
            dataset,
            ...(positivity ? { positivity } : {}),
            ...(outcomeUnit ? { outcomeUnit } : {}),
        });
    }

    // Für Negativkontrolle und implizierte Unabhängigkeiten braucht es
    // mehr als die Größen der Frage — deshalb ein zweites, breiteres
    // Panel. Es hat weniger Zeilen (jede zusätzliche Größe bringt ihre
    // Lücken mit), und genau deshalb ist es nicht das Panel der Schätzung.
    const widePanel = buildWidePanel(input, observable, lag);

    const refutations = runRefutations({
        panel,
        spec: estimateSpec,
        estimate: outcome.estimate,
        dag,
        ...(widePanel && widePanel.rows > 0 ? { wide: widePanel } : {}),
        seed: spec.seed,
        label,
        ...(input.bootstrapSamples !== undefined ? { bootstrapSamples: input.bootstrapSamples } : {}),
    });
    const passed = refutationPassed(refutations);

    const common = {
        ...base,
        adjustedFor: [...estimateSpec.adjustedFor],
        estimator,
        refutations,
        dataset,
        rawEstimate: outcome.estimate,
        ...(positivity ? { positivity } : {}),
        ...(outcomeUnit ? { outcomeUnit } : {}),
    };
    if (!passed) {
        const failures = refutations.filter(result => result.blocking && result.verdict !== 'passed');
        return {
            ...common,
            verdict: 'refuted',
            reason: `Die Schätzung ist durchgefallen: ${failures.map(result => result.description).join(' ')} `
                + 'Ein Effekt ohne bestandene Refutation wird nicht ausgegeben (Invariante C5).',
        };
    }
    return {
        ...common,
        verdict: 'passed',
        effect: outcome.estimate,
        reason: `Geschätzt über ${estimator} auf ${panel.rows} Zeilen; alle blockierenden `
            + 'Refutationsversuche bestanden.',
    };
}

function describeDataset(
    panel: Panel,
    required: ReadonlyArray<{ key: string; role: StudyDatasetInput['role'] }>,
    available: ReadonlyMap<string, StudySeries>,
    lag: number,
): StudyDataset {
    return {
        rows: panel.rows,
        intervalSeconds: panel.intervalSeconds,
        ...(panel.from !== undefined ? { from: panel.from } : {}),
        ...(panel.through !== undefined ? { through: panel.through } : {}),
        truncated: panel.truncated,
        inputs: required.map(entry => {
            const series = available.get(entry.key);
            const column = panel.column(entry.key);
            return {
                variable: entry.key,
                ...(series?.name ? { name: series.name } : {}),
                role: entry.role,
                lagSeconds: entry.role === 'treatment' ? lag : 0,
                intervalSeconds: series?.intervalSeconds ?? panel.intervalSeconds,
                ...(series?.aggregation ? { aggregation: series.aggregation } : {}),
                observationCount: series?.observations.length ?? 0,
                droppedRows: column?.droppedRows ?? 0,
            };
        }),
    };
}

function buildWidePanel(
    input: StudyInput,
    observable: ReadonlySet<string>,
    lag: number,
): Panel | null {
    const { spec, model } = input;
    const nodes = new Set(model.variables.map(variable => variable.iri));
    const series = input.series
        .filter(entry => nodes.has(entry.key) && observable.has(entry.key))
        .map(entry => ({
            ...entry,
            ...(entry.key === spec.treatment && lag > 0 ? { lagSeconds: lag } : {}),
        }));
    if (series.length < 2) return null;
    return buildPanel(series, {
        ...(spec.windowFrom !== undefined ? { from: spec.windowFrom } : {}),
        ...(spec.windowThrough !== undefined ? { through: spec.windowThrough } : {}),
        ...(input.maxRows !== undefined ? { maxRows: input.maxRows } : {}),
    });
}

/** Nachfahren der Behandlung — Grundlage der Negativkontrolle (§13.2). */
export function nonDescendantsOf(
    model: CausalModelView,
    treatment: string,
): string[] {
    const { dag } = dagFromModel(model);
    const forbidden = descendants(dag, [treatment], true);
    return model.variables.map(variable => variable.iri).filter(iri => !forbidden.has(iri)).sort();
}
