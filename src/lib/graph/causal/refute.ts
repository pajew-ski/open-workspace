/**
 * Refutation: der Versuch, die eigene Zahl zu widerlegen
 * (CAUSAL_LAYER_SPEC §13.1/13.2, Meilenstein C4).
 *
 * Invariante C5 ist die härteste dieses Layers: **Ein Effekt ohne
 * Refutation existiert nicht.** Deshalb steht dieses Modul nicht neben der
 * Schätzung, sondern hinter ihr — was hier durchfällt, wird nicht als
 * Effekt ausgegeben, sondern als durchgefallener Versuch angezeigt.
 * Verschwiegen wird nichts: Ein fehlgeschlagener Test ist ein Ergebnis.
 *
 * Zwei Ebenen, unterschiedlich hart (§13):
 *
 *  - **Pipeline-Refutation (§13.1)** — Placebo, zufällige gemeinsame
 *    Ursache, Teilmengen-Stabilität. Sie fängt Implementierungsfehler und
 *    Zufallsbefunde. Notwendig, nicht hinreichend, und genau so wird sie
 *    hier benannt.
 *  - **Modell-Refutation (§13.2)** — die vom DAG implizierten bedingten
 *    Unabhängigkeiten gegen die Daten testen, dazu eine Negativkontrolle.
 *    Ein Widerspruch falsifiziert nicht die Schätzung, sondern die
 *    **Annahme** — und damit alles, was aus ihr folgt.
 *
 * Die dritte Ebene (§13.3, randomisierte Experimente über Aktoren) ist
 * **nicht** Teil dieses Meilensteins: Sie greift in die Wohnung ein,
 * betrifft Mitbewohner und braucht eine ausdrückliche Freigabe (C7/C10).
 *
 * Das Modul ist **pur**; jeder Zufall kommt aus dem Seed der Studie (C7).
 */

import type { CausalDag } from './dag';
import { descendants } from './dag';
import { impliedIndependencies } from './dsep';
import { estimateEffect, buildEstimator, type EffectEstimate, type EstimateSpec } from './estimate';
import { createRandom, fisherZTest, normalDraw, partialCorrelation, standardDeviation } from './numeric';
import { withColumns, type Panel, type PanelColumn } from './panel';

export const REFUTATION_METHODS = [
    'placebo',
    'random-common-cause',
    'subset',
    'negative-control',
    'implied-independence',
    'e-value',
] as const;
export type RefutationMethod = (typeof REFUTATION_METHODS)[number];

export const REFUTATION_VERDICTS = ['passed', 'failed', 'inconclusive', 'informative'] as const;
export type RefutationVerdict = (typeof REFUTATION_VERDICTS)[number];

export const REFUTATION_LABEL: Record<RefutationMethod, string> = {
    placebo: 'Placebo-Behandlung',
    'random-common-cause': 'Zufällige gemeinsame Ursache',
    subset: 'Stabilität über Teilmengen',
    'negative-control': 'Negativkontrolle',
    'implied-independence': 'Implizierte Unabhängigkeiten',
    'e-value': 'E-Wert (Sensitivität)',
};

export interface RefutationResult {
    method: RefutationMethod;
    verdict: RefutationVerdict;
    /**
     * Blockierend heißt: Ein `failed` verhindert die Ausgabe des Effekts
     * (Invariante C5). Der E-Wert ist eine Kennzahl und blockiert nie —
     * er sagt, wie stark ein unbeobachteter Störfaktor sein müsste, nicht
     * ob es ihn gibt.
     */
    blocking: boolean;
    /** Kennzahl des Versuchs, quelltreu (Placebo-Effekt, E-Wert, p-Wert). */
    value?: number;
    /** Was geprüft wurde und was herauskam — ein Satz, deutsch. */
    description: string;
}

export interface RefutationInput {
    /** Das Panel der Studie: genau die Größen, mit denen geschätzt wurde. */
    panel: Panel;
    spec: EstimateSpec;
    estimate: EffectEstimate;
    dag: CausalDag;
    /**
     * Panel über ALLE erfassten Modellgrößen. Es hat weniger Zeilen (jede
     * zusätzliche Größe kann eine Lücke haben) und trägt deshalb nur die
     * Prüfungen, die zusätzliche Größen brauchen — Negativkontrolle und
     * implizierte Unabhängigkeiten.
     */
    wide?: Panel;
    seed: number;
    /** Beschriftung für die Begründung (Default: der Knoten selbst). */
    label?: (node: string) => string;
    bootstrapSamples?: number;
}

/**
 * Schwellen der Pipeline-Refutation. Sie stehen hier als benannte
 * Konstanten und nicht als Zahlen im Code, weil sie zur Aussage gehören:
 * Wer sie ändert, ändert, was „bestanden" heißt.
 */
export const REFUTATION_THRESHOLDS = {
    /** Placebo/Negativkontrolle: Vielfache des Standardfehlers um die Null. */
    zeroTolerance: 2,
    /** Zufällige gemeinsame Ursache: erlaubte relative Verschiebung. */
    relativeShift: 0.1,
    /** Teilmengen: Anteil der Zeilen je Teilmenge. */
    subsetShare: 0.8,
    /** Teilmengen: Anzahl geprüfter Fenster. */
    subsetWindows: 5,
    /** Modell-Refutation: Signifikanzniveau vor der Bonferroni-Korrektur. */
    alpha: 0.01,
    /** Modell-Refutation: Höchstzahl geprüfter Unabhängigkeiten. */
    maxIndependenceTests: 60,
} as const;

function rotate(values: readonly number[], offset: number): number[] {
    const n = values.length;
    const shift = ((offset % n) + n) % n;
    return values.map((_, index) => values[(index + shift) % n]);
}

/**
 * Placebo (§13.1): Die Behandlung wird zeitlich verschoben, ihre eigene
 * Struktur bleibt. Eine reine Permutation zerstörte die Autokorrelation
 * und wäre ein zu leichter Gegner — die Rotation lässt die Reihe, wie sie
 * ist, und trennt sie nur von ihrer Wirkung.
 */
function refutePlacebo(input: RefutationInput): RefutationResult {
    const { panel, spec, estimate } = input;
    const treatment = panel.column(spec.treatment);
    if (!treatment || panel.rows < 4) {
        return {
            method: 'placebo',
            verdict: 'inconclusive',
            blocking: true,
            description: 'Zu wenige Zeilen für eine Placebo-Behandlung.',
        };
    }
    const offset = Math.max(2, Math.floor(panel.rows / 3));
    const placeboPanel = withColumns(panel, [{ ...treatment, values: rotate(treatment.values, offset) }]);
    const built = buildEstimator(placeboPanel, spec);
    const rows = placeboPanel.timestamps.map((_, index) => index);
    const placebo = built.ok ? built.estimator.estimate(rows) : null;
    if (placebo === null || !Number.isFinite(placebo)) {
        return {
            method: 'placebo',
            verdict: 'inconclusive',
            blocking: true,
            description: 'Die Placebo-Behandlung ließ sich nicht schätzen — der Test sagt hier nichts.',
        };
    }
    const tolerance = REFUTATION_THRESHOLDS.zeroTolerance * estimate.standardError;
    const passed = Math.abs(placebo) <= tolerance;
    return {
        method: 'placebo',
        verdict: passed ? 'passed' : 'failed',
        blocking: true,
        value: placebo,
        description: passed
            ? `Die zeitlich verschobene Behandlung ergibt ${placebo.toFixed(4)} — im Rahmen der Null `
                + `(Toleranz ±${tolerance.toFixed(4)}). Der Effekt hängt nicht an der bloßen Form der Reihe.`
            : `Die zeitlich verschobene Behandlung ergibt ${placebo.toFixed(4)} statt einer Null `
                + `(Toleranz ±${tolerance.toFixed(4)}). Damit erzeugt schon eine Behandlung, die es so nie `
                + 'gab, denselben Befund — die Schätzung misst etwas anderes als den gesuchten Effekt.',
    };
}

/**
 * Zufällige gemeinsame Ursache (§13.1): eine erfundene Störgröße in die
 * Adjustierung. Sie kann nichts erklären; verschiebt sich der Effekt
 * trotzdem, hängt er an der Auslegung des Modells statt an den Daten.
 */
function refuteRandomCommonCause(input: RefutationInput): RefutationResult {
    const { panel, spec, estimate, seed } = input;
    const random = createRandom(seed + 1);
    const noise: PanelColumn = {
        key: `${spec.treatment}#random-common-cause`,
        kind: 'numeric',
        values: panel.timestamps.map(() => normalDraw(random)),
        lagSeconds: 0,
        droppedRows: 0,
    };
    const widened = withColumns(panel, [noise]);
    const built = buildEstimator(widened, { ...spec, adjustedFor: [...spec.adjustedFor, noise.key] });
    const rows = widened.timestamps.map((_, index) => index);
    const shifted = built.ok ? built.estimator.estimate(rows) : null;
    if (shifted === null || !Number.isFinite(shifted)) {
        return {
            method: 'random-common-cause',
            verdict: 'inconclusive',
            blocking: true,
            description: 'Mit zusätzlicher Störgröße ließ sich nicht mehr schätzen — der Test sagt hier nichts.',
        };
    }
    const drift = Math.abs(shifted - estimate.effect);
    const tolerance = Math.max(
        REFUTATION_THRESHOLDS.relativeShift * Math.abs(estimate.effect),
        0.5 * estimate.standardError,
    );
    const passed = drift <= tolerance;
    return {
        method: 'random-common-cause',
        verdict: passed ? 'passed' : 'failed',
        blocking: true,
        value: shifted,
        description: passed
            ? `Mit einer zufälligen zusätzlichen Störgröße bleibt der Effekt bei ${shifted.toFixed(4)} `
                + `(Verschiebung ${drift.toFixed(4)}, erlaubt ${tolerance.toFixed(4)}).`
            : `Eine zufällige Störgröße verschiebt den Effekt auf ${shifted.toFixed(4)} `
                + `(Verschiebung ${drift.toFixed(4)}, erlaubt ${tolerance.toFixed(4)}). Eine Größe ohne `
                + 'jeden Zusammenhang darf das nicht können — die Schätzung ist instabil.',
    };
}

/**
 * Teilmengen-Stabilität (§13.1): zusammenhängende Fenster statt zufälliger
 * Zeilen. Bei einer Zeitreihe ist ein Zufallssample keine Teilmenge,
 * sondern ein anderes Objekt — nur ein Fenster ist eine Datenlage, die es
 * so hätte geben können.
 */
function refuteSubset(input: RefutationInput): RefutationResult {
    const { panel, spec, estimate } = input;
    const built = buildEstimator(panel, spec);
    if (!built.ok) {
        return {
            method: 'subset',
            verdict: 'inconclusive',
            blocking: true,
            description: 'Auf Teilmengen ließ sich nicht schätzen — der Test sagt hier nichts.',
        };
    }
    const length = Math.floor(panel.rows * REFUTATION_THRESHOLDS.subsetShare);
    if (length < 10 || length >= panel.rows) {
        return {
            method: 'subset',
            verdict: 'inconclusive',
            blocking: true,
            description: 'Zu wenige Zeilen, um sinnvolle Teilmengen zu bilden.',
        };
    }
    const windows = REFUTATION_THRESHOLDS.subsetWindows;
    const stride = Math.max(1, Math.floor((panel.rows - length) / Math.max(1, windows - 1)));
    const tolerance = REFUTATION_THRESHOLDS.zeroTolerance * estimate.standardError;
    const values: number[] = [];
    for (let index = 0; index < windows; index += 1) {
        const start = Math.min(index * stride, panel.rows - length);
        const rows = Array.from({ length }, (_, offset) => start + offset);
        const value = built.estimator.estimate(rows);
        if (value !== null && Number.isFinite(value)) values.push(value);
    }
    if (values.length < 3) {
        return {
            method: 'subset',
            verdict: 'inconclusive',
            blocking: true,
            description: 'Die meisten Teilmengen lieferten kein Ergebnis — der Test sagt hier nichts.',
        };
    }
    const worst = values.reduce(
        (max, value) => Math.max(max, Math.abs(value - estimate.effect)),
        0,
    );
    const passed = worst <= tolerance;
    return {
        method: 'subset',
        verdict: passed ? 'passed' : 'failed',
        blocking: true,
        value: worst,
        description: passed
            ? `Über ${values.length} Zeitfenster weicht der Effekt höchstens um ${worst.toFixed(4)} ab `
                + `(erlaubt ${tolerance.toFixed(4)}).`
            : `Über ${values.length} Zeitfenster weicht der Effekt um bis zu ${worst.toFixed(4)} ab `
                + `(erlaubt ${tolerance.toFixed(4)}). Ein Effekt, der in der Hälfte des Fensters ein `
                + 'anderer ist, ist keiner.',
    };
}

/**
 * Negativkontrolle (§13.2): eine Wirkung, die die Behandlung nach dem
 * Modell **nicht** beeinflussen kann — also kein Nachfahre von ihr ist.
 * Zeigt sich dort ein Effekt, steckt der Fehler im Verfahren oder in einer
 * unbeobachteten gemeinsamen Ursache, nicht in der Wirkung.
 */
function refuteNegativeControl(input: RefutationInput): RefutationResult {
    const { spec, dag, seed } = input;
    const label = input.label ?? ((node: string) => node);
    const panel = input.wide ?? input.panel;
    const forbidden = descendants(dag, [spec.treatment], true);
    const candidates = panel.columns
        .map(column => column.key)
        .filter(key => key !== spec.outcome
            && key !== spec.controlOutcome
            && !forbidden.has(key)
            && !spec.adjustedFor.includes(key))
        .sort();
    const candidate = candidates[0];
    if (!candidate) {
        return {
            method: 'negative-control',
            verdict: 'inconclusive',
            blocking: false,
            description: 'Das Modell kennt keine erfasste Größe, die die Behandlung nicht beeinflussen '
                + 'kann — ohne eine solche gibt es keine Negativkontrolle.',
        };
    }
    const outcome = estimateEffect(
        panel,
        { ...spec, outcome: candidate },
        { seed: seed + 2, samples: input.bootstrapSamples },
    );
    if (!outcome.ok) {
        return {
            method: 'negative-control',
            verdict: 'inconclusive',
            blocking: false,
            description: `Die Negativkontrolle „${label(candidate)}" ließ sich nicht schätzen: `
                + outcome.problem,
        };
    }
    const { effect, ciLow, ciHigh } = outcome.estimate;
    const passed = ciLow <= 0 && ciHigh >= 0;
    return {
        method: 'negative-control',
        verdict: passed ? 'passed' : 'failed',
        blocking: true,
        value: effect,
        description: passed
            ? `Auf „${label(candidate)}", das die Behandlung nicht erreichen kann, zeigt sich kein Effekt `
                + `(${effect.toFixed(4)}, Intervall ${ciLow.toFixed(4)} bis ${ciHigh.toFixed(4)}).`
            : `Auf „${label(candidate)}" zeigt sich ein Effekt (${effect.toFixed(4)}, Intervall `
                + `${ciLow.toFixed(4)} bis ${ciHigh.toFixed(4)}), obwohl die Behandlung diese Größe nach `
                + 'dem Modell nicht erreichen kann. Etwas wirkt hier, das nicht im Modell steht.',
    };
}

/**
 * Modell-Refutation (§13.2, die schärfere Ebene): Der DAG behauptet
 * bedingte Unabhängigkeiten. Sie sind testbar — und wenn die Daten ihnen
 * widersprechen, ist nicht die Schätzung falsch, sondern die **Annahme**.
 * Geprüft wird mit Bonferroni-Korrektur: Bei vierzig Tests findet man
 * sonst sicher einen Widerspruch, und der wäre keiner.
 */
function refuteImpliedIndependence(input: RefutationInput): RefutationResult {
    const label = input.label ?? ((node: string) => node);
    const panel = input.wide ?? input.panel;
    const available = new Set(panel.columns.map(column => column.key));
    const claims = impliedIndependencies(input.dag)
        .filter(claim => available.has(claim.a) && available.has(claim.b)
            && claim.given.every(node => available.has(node)))
        .slice(0, REFUTATION_THRESHOLDS.maxIndependenceTests);
    if (claims.length === 0 || panel.rows < 20) {
        return {
            method: 'implied-independence',
            verdict: 'inconclusive',
            blocking: false,
            description: claims.length === 0
                ? 'Das Modell behauptet keine bedingte Unabhängigkeit, die sich mit den erfassten Größen '
                    + 'prüfen ließe — es ist in diesem Sinn nicht widerlegbar.'
                : 'Zu wenige gemeinsame Zeilen, um die implizierten Unabhängigkeiten zu prüfen.',
        };
    }

    const alpha = REFUTATION_THRESHOLDS.alpha / claims.length;
    let worst: { a: string; b: string; given: string[]; p: number } | null = null;
    let tested = 0;
    for (const claim of claims) {
        const a = panel.column(claim.a);
        const b = panel.column(claim.b);
        if (!a || !b) continue;
        const conditioning = claim.given
            .map(node => panel.column(node)?.values)
            .filter((values): values is number[] => values !== undefined);
        const r = partialCorrelation(a.values, b.values, conditioning);
        if (r === null) continue;
        const p = fisherZTest(r, panel.rows, conditioning.length);
        if (p === null) continue;
        tested += 1;
        if (!worst || p < worst.p) worst = { a: claim.a, b: claim.b, given: claim.given, p };
    }
    if (!worst || tested === 0) {
        return {
            method: 'implied-independence',
            verdict: 'inconclusive',
            blocking: false,
            description: 'Keine der implizierten Unabhängigkeiten ließ sich rechnen (zu wenig Varianz).',
        };
    }
    const given = worst.given.length > 0
        ? ` gegeben ${worst.given.map(label).join(', ')}`
        : ' (unbedingt)';
    const passed = worst.p >= alpha;
    return {
        method: 'implied-independence',
        verdict: passed ? 'passed' : 'failed',
        blocking: true,
        value: worst.p,
        description: passed
            ? `${tested} vom Modell behauptete Unabhängigkeiten geprüft; die knappste `
                + `(${label(worst.a)} ⟂ ${label(worst.b)}${given}) hält mit p = ${worst.p.toFixed(4)} `
                + `(Schwelle ${alpha.toFixed(5)}).`
            : `Die Daten widersprechen dem Modell: ${label(worst.a)} und ${label(worst.b)} sind${given} `
                + `nicht unabhängig (p = ${worst.p.toFixed(5)}, Schwelle ${alpha.toFixed(5)}), obwohl der `
                + 'DAG genau das behauptet. Damit ist die Annahme widerlegt, nicht nur die Zahl — '
                + 'der Effekt wird nicht ausgegeben, bis die Struktur stimmt.',
    };
}

/**
 * E-Wert (§13.2, VanderWeele/Ding): Wie stark müsste ein **unbeobachteter**
 * Störfaktor mit Behandlung und Wirkung zusammenhängen, um den Befund zu
 * erklären? Ein E-Wert nahe 1 heißt: schon eine Kleinigkeit genügt. Der
 * Test kann nichts widerlegen und blockiert deshalb nie — er sagt, wie
 * viel Vertrauen die Zahl verdient.
 */
function eValue(input: RefutationInput): RefutationResult {
    const outcome = input.panel.column(input.spec.outcome);
    const spread = outcome ? standardDeviation(outcome.values) : 0;
    if (!outcome || spread <= 0) {
        return {
            method: 'e-value',
            verdict: 'inconclusive',
            blocking: false,
            description: 'Ohne Streuung in der Wirkung lässt sich kein E-Wert bilden.',
        };
    }
    // Standardisierte Differenz → Risikoverhältnis (Näherung nach Ding/
    // VanderWeele), dann der E-Wert als dessen Schwelle.
    const d = input.estimate.effect / spread;
    const rr = Math.exp(0.91 * Math.abs(d));
    const e = rr + Math.sqrt(rr * (rr - 1));
    return {
        method: 'e-value',
        verdict: 'informative',
        blocking: false,
        value: e,
        description: `Ein unbeobachteter Störfaktor müsste mit Behandlung und Wirkung jeweils um den `
            + `Faktor ${e.toFixed(2)} zusammenhängen, um diesen Befund vollständig zu erklären `
            + `(standardisierte Differenz ${d.toFixed(3)}). Je näher an 1, desto weniger trägt die Zahl.`,
    };
}

/**
 * Alle Refutationen in fester Reihenfolge. Sie ist Teil der Signatur:
 * Zwei Läufe derselben Studie müssen dieselbe Liste ergeben (C7).
 */
export function runRefutations(input: RefutationInput): RefutationResult[] {
    return [
        refutePlacebo(input),
        refuteRandomCommonCause(input),
        refuteSubset(input),
        refuteNegativeControl(input),
        refuteImpliedIndependence(input),
        eValue(input),
    ];
}

/**
 * Hat die Refutation als Ganzes bestanden? Nein, sobald ein blockierender
 * Versuch fehlgeschlagen ist ODER unentschieden blieb: „Wir konnten es
 * nicht prüfen" ist kein Bestehen (Invariante C5). Der E-Wert und eine
 * fehlende Negativkontrolle blockieren nicht — sie sind als
 * nicht-blockierend gekennzeichnet.
 */
export function refutationPassed(results: readonly RefutationResult[]): boolean {
    return results.every(result => !result.blocking || result.verdict === 'passed');
}

/** Die blockierenden Versuche, die dagegen sprechen — für die Begründung. */
export function blockingFailures(results: readonly RefutationResult[]): RefutationResult[] {
    return results.filter(result => result.blocking && result.verdict !== 'passed');
}
