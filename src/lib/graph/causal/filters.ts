/**
 * Die symbolischen Filter (CAUSAL_LAYER_SPEC §8, Meilenstein C6).
 *
 * §8 teilt die Arbeit in drei Rollen mit klarer Beweislast: **Das LLM
 * schlägt vor, die Symbolik richtet, die Daten entscheiden.** Dieses Modul
 * ist die mittlere Rolle — und sie ist die billigste. Jeder Filter hier
 * kostet Millisekunden und nimmt Vorschläge weg, die sonst eine
 * vollständige Schätzung samt Bootstrap und sechs Refutationen verbrannt
 * hätten.
 *
 * Das Modul ist **pur** wie der übrige Tier-1-Kern (`dag`, `dsep`,
 * `identify`): kein Store, kein Netz, keine Route. Ein Test erzwingt das,
 * und deshalb kann derselbe Filter im Browser laufen, bevor ein Vorschlag
 * überhaupt gespeichert wird (Invariante C9).
 *
 * **Vier harte Filter und ein konstruktiver.**
 *
 *  1. `cycle` — die Kante schlösse einen Kreis. In einem Zyklus ist keine
 *     Aussage über Identifizierbarkeit mehr möglich (C1); abgelehnt wird
 *     mit dem Kreis im Klartext, nicht mit „ungültig".
 *  2. `shacl` — Typverträglichkeit und Form. Läuft NICHT hier, sondern im
 *     Schreibpfad gegen `graph/shapes`; der Filter ist trotzdem hier
 *     benannt, damit die Aufzählung vollständig bleibt und die Oberfläche
 *     nach einer Ursache gruppieren kann.
 *  3. `temporal` — die Ursache muss der Wirkung vorausgehen.
 *  4. `topology` — ein Gerät in Raum B beeinflusst Raum A nicht ohne Pfad.
 *  5. Identifizierbarkeit — **kein** harter Filter, siehe unten.
 *
 * **Was die temporale Zulässigkeit hier heißt — und was nicht.** §8 sagt,
 * sie sei „mit HA-Zeitstempeln maschinell entscheidbar". Entscheidbar ist
 * aus Zeitstempeln allein zweierlei: das Vorzeichen des Zeitversatzes
 * (ein negativer Versatz behauptet, die Wirkung ginge der Ursache voraus)
 * und die Abdeckung (wurde die Ursache überhaupt zu einer Zeit erfasst,
 * die einer erfassten Wirkung vorausgeht?). Was NICHT daraus folgt, ist
 * die Richtung der Wirkung: Sie aus Korrelationen zu erschließen wäre
 * Struktur-Lernen und damit C8, der ausdrücklich nicht Teil dieses
 * Meilensteins ist (§19). Ein Filter, der so täte, als könne er das,
 * wäre eine Attrappe mit Rechenzeit.
 *
 * **Warum Identifizierbarkeit nicht ablehnt.** Sie hängt daran, welche
 * Störgrößen *erfasst* sind — eine Frage der Datenlage, nicht der
 * Struktur. Einen strukturell einwandfreien Vorschlag zu verwerfen, weil
 * die Außentemperatur noch nicht erfasst wird, hieße die Daten über die
 * Annahme entscheiden zu lassen, und genau das verbietet Invariante C1.
 * Das Urteil lautet deshalb `open`, und die Begründung nennt die fehlende
 * Größe — §8 nennt das ausdrücklich „die konstruktive Antwort und in der
 * Praxis oft die nützlichste". In den Studien-Pfad kommt ein solcher
 * Vorschlag trotzdem nicht: Ohne Identifikation rechnet C4 keine Zahl,
 * sondern gibt „nicht identifizierbar" zurück.
 */

import { createDag, findCycle, type CausalDag } from './dag';
import { identifyEffect } from './identify';

/** Die Filterstufen aus §8, in der Reihenfolge ihrer Anwendung. */
export const HYPOTHESIS_FILTERS = ['cycle', 'shacl', 'temporal', 'topology'] as const;
export type HypothesisFilter = (typeof HYPOTHESIS_FILTERS)[number];

export const HYPOTHESIS_FILTER_LABEL: Record<HypothesisFilter, string> = {
    cycle: 'Azyklizität',
    shacl: 'Shapes',
    temporal: 'Zeitliche Zulässigkeit',
    topology: 'Topologie',
};

/**
 * Drei Urteile. `open` ist bewusst kein halbes `rejected`: Der Vorschlag
 * darf ins Modell, er trägt nur noch keine Zahl.
 */
export const HYPOTHESIS_VERDICTS = ['accepted', 'open', 'rejected'] as const;
export type HypothesisVerdict = (typeof HYPOTHESIS_VERDICTS)[number];

export const HYPOTHESIS_VERDICT_LABEL: Record<HypothesisVerdict, string> = {
    accepted: 'Zulässig',
    open: 'Zulässig, aber nicht schätzbar',
    rejected: 'Verworfen',
};

/** Ein Vorschlag, bevor er ein Graph-Bürger wird. */
export interface CandidateEdge {
    from: string;
    to: string;
    /** ISO-8601-Dauer, quelltreu vom Vorschlagenden (`PT15M`). */
    temporalLag?: string;
}

/** Erfassungsfenster einer Größe (C3) — die Grundlage des Zeit-Filters. */
export interface CoverageWindow {
    /** `ow:capturedFrom`, ISO-Zeitpunkt. */
    from?: string;
    /** `ow:capturedThrough`, ISO-Zeitpunkt. */
    through?: string;
}

/**
 * Verortung einer Größe für den Topologie-Filter. `global` heißt: Die
 * Größe hat keinen Ort im Haus, weil sie überall gilt — Außentemperatur,
 * Strompreis, Sonnenstand, Feiertag. Sie ist damit nie topologisch
 * unplausibel, und das ist keine Ausnahme, sondern der Normalfall für
 * jede Störgröße aus offenen Quellen (C5).
 */
export interface TopologyInfo {
    placeIri?: string;
    /** Der Ort und seine Oberorte (`schema:containedInPlace`), von innen nach außen. */
    placeChain?: readonly string[];
    global?: boolean;
}

export interface FilterContext {
    /** Der DAG des Zielmodells — ohne den Vorschlag. */
    dag: CausalDag;
    /** Erfasste Größen (C3): nur über sie lässt sich adjustieren. */
    observable: ReadonlySet<string>;
    coverage: ReadonlyMap<string, CoverageWindow>;
    topology: ReadonlyMap<string, TopologyInfo>;
    label(node: string): string;
}

export interface FilterOutcome {
    verdict: HypothesisVerdict;
    /** Nur bei `rejected` gesetzt. */
    rejectedBy?: HypothesisFilter;
    /** Begründung in einem Satz, immer gesetzt. */
    reason: string;
    /**
     * Größen, deren Erfassung den Effekt schätzbar machen würde — die
     * konstruktive Antwort aus §8. Nur bei `open` gefüllt.
     */
    missingVariables?: string[];
}

/** `PT15M` → 900; `-PT15M` → −900; unbekannte Formen → `null`. */
export function lagSeconds(value: string): number | null {
    const match = /^(-)?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
    if (!match || match.slice(2).every(part => part === undefined)) return null;
    const seconds = Number(match[2] ?? 0) * 86400
        + Number(match[3] ?? 0) * 3600
        + Number(match[4] ?? 0) * 60
        + Number(match[5] ?? 0);
    return match[1] ? -seconds : seconds;
}

function timestamp(value: string | undefined): number | null {
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Filter 1 (§8): Azyklizität. Geprüft wird der DAG MIT dem Vorschlag —
 * eine Kante, die einen Kreis schließt, ist keine Hypothese, sondern ein
 * Widerspruch zur bereits gesetzten Struktur.
 */
export function checkAcyclic(context: FilterContext, candidate: CandidateEdge): FilterOutcome | null {
    if (candidate.from === candidate.to) {
        return {
            verdict: 'rejected',
            rejectedBy: 'cycle',
            reason: `„${context.label(candidate.from)}" kann nicht ihre eigene Ursache sein.`,
        };
    }
    const next = createDag({
        nodes: [...context.dag.nodes, candidate.from, candidate.to],
        edges: [...context.dag.edges, { from: candidate.from, to: candidate.to }],
    });
    const cycle = findCycle(next);
    if (!cycle) return null;
    return {
        verdict: 'rejected',
        rejectedBy: 'cycle',
        reason: `Der Vorschlag schließt einen Kreis: ${cycle.map(context.label).join(' → ')}. `
            + 'Das Modell behauptet die Gegenrichtung bereits — beides zugleich kann nicht gelten.',
    };
}

/**
 * Filter 3 (§8): temporale Zulässigkeit. Zwei Prüfungen, beide allein aus
 * Zeitstempeln entscheidbar (siehe Kopfkommentar).
 */
export function checkTemporal(context: FilterContext, candidate: CandidateEdge): FilterOutcome | null {
    const lag = candidate.temporalLag !== undefined ? lagSeconds(candidate.temporalLag) : 0;
    if (candidate.temporalLag !== undefined && lag === null) {
        return {
            verdict: 'rejected',
            rejectedBy: 'temporal',
            reason: `„${candidate.temporalLag}" ist keine ISO-8601-Dauer (z. B. PT15M für 15 Minuten).`,
        };
    }
    if (lag !== null && lag < 0) {
        return {
            verdict: 'rejected',
            rejectedBy: 'temporal',
            reason: `Ein negativer Zeitversatz (${candidate.temporalLag}) behauptet, `
                + `„${context.label(candidate.to)}" ginge „${context.label(candidate.from)}" voraus. `
                + 'Dann ist die vorgeschlagene Richtung die falsche.',
        };
    }

    // Abdeckung: Damit eine Beobachtung der Ursache einer Beobachtung der
    // Wirkung vorausgehen kann, muss die Erfassung der Ursache — um ihren
    // Zeitversatz verschoben — vor dem Ende der Wirkung beginnen. Fehlt
    // eine der Angaben, wird NICHT abgelehnt: Unwissen ist kein Befund.
    const causeFrom = timestamp(context.coverage.get(candidate.from)?.from);
    const effectThrough = timestamp(context.coverage.get(candidate.to)?.through);
    if (causeFrom !== null && effectThrough !== null && causeFrom + (lag ?? 0) * 1000 > effectThrough) {
        return {
            verdict: 'rejected',
            rejectedBy: 'temporal',
            reason: `„${context.label(candidate.from)}" wird erst seit dem `
                + `${formatDay(causeFrom)} erfasst, „${context.label(candidate.to)}" nur bis zum `
                + `${formatDay(effectThrough)}. Keine erfasste Ursache geht hier einer erfassten `
                + 'Wirkung voraus — der Vorschlag ist zeitlich unmöglich.',
        };
    }
    return null;
}

function formatDay(at: number): string {
    return new Date(at).toISOString().slice(0, 10);
}

/**
 * Filter 4 (§8): topologische Plausibilität. Die Device Registry ist hier
 * ein echter Prior — ein Heizkörper im Schlafzimmer wirkt nicht auf einen
 * Sensor im Keller, ohne dass ein Pfad zwischen beiden Orten bestünde.
 *
 * Plausibel ist ein Paar, wenn mindestens eines gilt:
 *  - eine Seite ist ortlos oder global (Wetter, Preis, Sonnenstand),
 *  - beide sitzen am selben Ort,
 *  - ein Ort enthält den anderen (`schema:containedInPlace`), oder
 *  - beide teilen sich einen Oberort (dieselbe Etage).
 *
 * Fehlt die Verortung, wird NICHT abgelehnt. Ein Modell darf Größen
 * enthalten, die kein Connector materialisiert hat.
 */
export function checkTopology(context: FilterContext, candidate: CandidateEdge): FilterOutcome | null {
    const cause = context.topology.get(candidate.from);
    const effect = context.topology.get(candidate.to);
    if (!cause || !effect) return null;
    if (cause.global || effect.global) return null;
    const causeChain = cause.placeChain ?? (cause.placeIri ? [cause.placeIri] : []);
    const effectChain = effect.placeChain ?? (effect.placeIri ? [effect.placeIri] : []);
    if (causeChain.length === 0 || effectChain.length === 0) return null;
    if (causeChain.some(place => effectChain.includes(place))) return null;

    const placeName = (chain: readonly string[]) => context.label(chain[0]);
    return {
        verdict: 'rejected',
        rejectedBy: 'topology',
        reason: `„${context.label(candidate.from)}" sitzt in ${placeName(causeChain)}, `
            + `„${context.label(candidate.to)}" in ${placeName(effectChain)}. `
            + 'Die Geräte-Topologie kennt zwischen beiden Orten keinen Pfad — ohne einen solchen '
            + 'ist eine direkte Wirkung nicht plausibel.',
    };
}

/**
 * Filter 5 (§8), konstruktiv statt ablehnend: Wäre der vorgeschlagene
 * Effekt aus den ERFASSTEN Größen überhaupt bestimmbar? Wenn nein, sagt
 * die Antwort, welche Variable fehlen würde.
 */
export function checkIdentifiable(context: FilterContext, candidate: CandidateEdge): FilterOutcome {
    const dag = createDag({
        nodes: [...context.dag.nodes, candidate.from, candidate.to],
        edges: [...context.dag.edges, { from: candidate.from, to: candidate.to }],
    });
    const result = identifyEffect(dag, candidate.from, candidate.to, {
        label: context.label,
        observable: context.observable,
    });
    if (result.identifiable) {
        return { verdict: 'accepted', reason: result.reason };
    }
    return {
        verdict: 'open',
        reason: result.reason,
        ...(result.missingVariables.length > 0 ? { missingVariables: result.missingVariables } : {}),
    };
}

/**
 * Alle Filter in der Reihenfolge aus §8 — ohne `shacl`, der die Shapes
 * braucht und deshalb im Schreibpfad läuft (`applyShaclFilter`).
 *
 * Der erste harte Filter, der greift, entscheidet. Weiterzuprüfen wäre
 * nicht nur Verschwendung, sondern irreführend: Eine Begründung, die
 * gleichzeitig „schließt einen Kreis" und „nicht identifizierbar" sagt,
 * lenkt von der Ursache ab, die man tatsächlich beheben müsste.
 */
export function applyFilters(context: FilterContext, candidate: CandidateEdge): FilterOutcome {
    return checkAcyclic(context, candidate)
        ?? checkTemporal(context, candidate)
        ?? checkTopology(context, candidate)
        ?? checkIdentifiable(context, candidate);
}

/**
 * Darf dieser Vorschlag in ein Modell übernommen werden? Genau die zwei
 * Urteile, die kein harter Filter verworfen hat. Das ist die Regel, die
 * die C6-Abnahme meint („keine Hypothese erreicht ohne Filter den
 * Studien-Pfad") — und sie wird serverseitig durchgesetzt, nicht nur in
 * der Oberfläche ausgegraut.
 */
export function mayAdopt(verdict: HypothesisVerdict): boolean {
    return verdict === 'accepted' || verdict === 'open';
}
