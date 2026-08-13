/**
 * Identifikation (CAUSAL_LAYER_SPEC §7 Tier 1, Meilenstein C1).
 *
 * Die Frage dieses Moduls ist die Frage VOR jeder Zahl: **Lässt sich der
 * Effekt von A auf B aus Beobachtungsdaten überhaupt bestimmen — und
 * wenn ja, worüber muss adjustiert werden?** Antwortet der Graph mit
 * „nein", ist das ein wertvolles Ergebnis und wird als solches ausgegeben
 * (§7): mit Begründung und mit dem Namen der Variablen, an der es hängt.
 *
 * Was hier NICHT passiert: schätzen. Es gibt keine Effektstärke, kein
 * Konfidenzintervall, keine Daten — das ist C4. Dieses Modul sieht
 * ausschließlich den DAG, und der ist eine Annahme (Invariante C1).
 *
 * Verfahren (Standardliteratur, keine Eigenerfindung):
 *
 *  - **Adjustment-Kriterium** (Shpitser/van der Zander u. a.) statt des
 *    engeren Backdoor-Kriteriums: Z ist zulässig, wenn Z keinen Nachfahren
 *    eines Knotens auf einem echten Wirkweg enthält UND im *proper
 *    backdoor graph* alle Wege zwischen Ursache und Wirkung blockiert.
 *    Beides fällt für den Standardfall mit Pearls Hintertür zusammen.
 *  - **Kanonische Menge**: `An(X ∪ Y) \ ({X, Y} ∪ dpcp)`. Sie ist genau
 *    dann zulässig, wenn es überhaupt eine zulässige Menge gibt — deshalb
 *    entscheidet sie die Identifizierbarkeit, und die Suche nach
 *    minimalen Mengen läuft nur innerhalb von ihr.
 *  - **Frontdoor** über Mediatoren, **Instrumente** über den operierten
 *    Graphen `G_X̲`.
 *
 * **Beobachtbarkeit** ist Teil der Antwort: Eine Variable, die im Modell
 * steht, aber nicht erfasst wird (C3), kann nicht adjustiert werden. Genau
 * daraus entsteht die ehrliche Auskunft „identifizierbar, aber nicht
 * schätzbar — es fehlt die Außentemperatur".
 */

import {
    ancestors,
    createDag,
    descendants,
    findCycle,
    mutilate,
    type CausalDag,
    type DagEdge,
} from './dag';
import { dConnected, dSeparated, findPaths, type DagPath } from './dsep';

export type IdentificationStrategy = 'backdoor' | 'frontdoor' | 'iv' | 'none';

export interface InstrumentView {
    /** Die Instrumentvariable. */
    node: string;
    /** Menge, unter der sie ein Instrument ist (leer = unbedingt). */
    given: string[];
}

export interface IdentifyOptions {
    /**
     * Beobachtbare Knoten. Ohne Angabe gilt jeder Modellknoten als
     * beobachtbar — das ist die Sicht auf die reine Struktur, wie sie
     * Lehrbuch-DAGs meinen.
     */
    observable?: Iterable<string>;
    /** Beschriftung für die Begründung (Default: der Knoten selbst). */
    label?: (node: string) => string;
    /** Höchstzahl zurückgegebener Mengen je Art (Default 6). */
    maxSets?: number;
    /** Größte gesuchte Menge (Default 4). */
    maxSetSize?: number;
    /** Höchstzahl geprüfter Mengen insgesamt (Default 20000). */
    budget?: number;
}

export interface IdentificationResult {
    exposure: string;
    outcome: string;
    /** Azyklisch? Ein Zyklus macht jede weitere Aussage sinnlos. */
    acyclic: boolean;
    cycle: string[] | null;
    /** Behauptet das Modell überhaupt einen Wirkweg? */
    zeroEffect: boolean;
    identifiable: boolean;
    strategy: IdentificationStrategy;
    /** Zulässige Adjustment Sets aus beobachtbaren Variablen. */
    adjustmentSets: string[][];
    /**
     * Sind die gefundenen Mengen minimal? `false` heißt: Die Suche nach
     * kleineren Mengen wurde gedeckelt, und was hier steht, ist die
     * kanonische Menge — zulässig, aber größer als nötig.
     */
    adjustmentSetsMinimal: boolean;
    /** Die kanonische Menge (ohne Beobachtbarkeits-Filter), falls zulässig. */
    canonicalSet: string[] | null;
    /** Minimale Frontdoor-Mengen (Mediatoren), falls es welche gibt. */
    frontdoorSets: string[][];
    instruments: InstrumentView[];
    /**
     * Variablen, die zum Schließen der Hintertür gebraucht würden, aber
     * nicht erfasst sind — die Antwort auf „welche Variable fehlt?".
     */
    missingVariables: string[];
    /** Offene Hintertürpfade ohne Adjustierung (Erklärung, gedeckelt). */
    openBackdoorPaths: DagPath[];
    /** Wurde eine Suche gedeckelt? Dann ist die Liste nicht vollständig. */
    truncated: boolean;
    /** Begründung in einem Satz, immer gesetzt. */
    reason: string;
}

const DEFAULTS = { maxSets: 6, maxSetSize: 4, budget: 20000 } as const;

/**
 * Knoten auf einem echten Wirkweg von `x` nach `y`, ohne `x` selbst
 * (`cn(X,Y)` der Literatur). Im DAG ist das schlicht: Nachfahre von x und
 * Vorfahre von y — ein Umweg über x zurück kann es nicht geben.
 */
export function causalPathNodes(dag: CausalDag, x: string, y: string): Set<string> {
    const below = descendants(dag, [x], false);
    const above = ancestors(dag, [y], true);
    const out = new Set<string>();
    for (const node of below) {
        if (node !== x && above.has(node)) out.add(node);
    }
    return out;
}

/** `dpcp(X,Y)`: Nachfahren der Wirkweg-Knoten — nie adjustierbar. */
function forbiddenNodes(dag: CausalDag, x: string, y: string): Set<string> {
    const forbidden = descendants(dag, causalPathNodes(dag, x, y), true);
    forbidden.add(x);
    forbidden.add(y);
    return forbidden;
}

/**
 * Der *proper backdoor graph*: dieselbe Struktur ohne die erste Kante
 * jedes echten Wirkwegs. Was darin noch verbindet, ist genau das, was
 * eine Adjustierung schließen muss.
 */
function properBackdoorGraph(dag: CausalDag, x: string, y: string): CausalDag {
    const causal = causalPathNodes(dag, x, y);
    const removeEdges: DagEdge[] = dag.edges.filter(edge => edge.from === x && causal.has(edge.to));
    return mutilate(dag, { removeEdges });
}

export interface AdjustmentCheck {
    valid: boolean;
    /** Grund der Ablehnung, falls ungültig. */
    violation: 'forbidden-node' | 'open-path' | null;
    /** Der verbotene Knoten, falls es an ihm liegt. */
    offending: string | null;
}

/**
 * Ein wiederverwendbarer Prüfer. Verbotene Knoten und der proper backdoor
 * graph hängen nur an (X, Y) — sie einmal zu berechnen statt je Kandidat
 * ist der Unterschied zwischen „läuft im Browser" und „hakt".
 */
function adjustmentChecker(dag: CausalDag, x: string, y: string): (set: Iterable<string>) => AdjustmentCheck {
    const forbidden = forbiddenNodes(dag, x, y);
    const pbd = properBackdoorGraph(dag, x, y);
    return set => {
        const z = [...set];
        const offending = z.find(node => forbidden.has(node));
        if (offending !== undefined) {
            return { valid: false, violation: 'forbidden-node', offending };
        }
        if (!dSeparated(pbd, [x], [y], z)) {
            return { valid: false, violation: 'open-path', offending: null };
        }
        return { valid: true, violation: null, offending: null };
    };
}

/**
 * Prüft eine Menge gegen das Adjustment-Kriterium. Das ist die eine
 * Stelle, an der „gültig" definiert ist — Backdoor, Frontdoor und die
 * Suche nach minimalen Mengen fragen alle hier.
 */
export function checkAdjustment(
    dag: CausalDag,
    x: string,
    y: string,
    set: Iterable<string>,
): AdjustmentCheck {
    return adjustmentChecker(dag, x, y)(set);
}

/** Die kanonische Adjustment-Menge (ohne Beobachtbarkeits-Filter). */
export function canonicalAdjustmentSet(dag: CausalDag, x: string, y: string): string[] {
    const forbidden = forbiddenNodes(dag, x, y);
    const relevant = ancestors(dag, [x, y], true);
    return dag.nodes.filter(node => relevant.has(node) && !forbidden.has(node));
}

interface SearchState {
    checks: number;
    budget: number;
    truncated: boolean;
}

/**
 * Minimale Mengen über einem Universum, aufsteigend nach Größe. Weil
 * aufsteigend gesucht wird, ist jede gefundene Menge automatisch
 * teilmengen-minimal — Obermengen bereits gefundener Lösungen werden
 * übersprungen.
 */
function minimalSets(
    universe: readonly string[],
    maxSize: number,
    maxSets: number,
    state: SearchState,
    valid: (candidate: string[]) => boolean,
): string[][] {
    const found: string[][] = [];
    const covers = (candidate: readonly string[]) =>
        found.some(set => set.every(node => candidate.includes(node)));

    const check = (candidate: string[]): boolean => {
        if (state.checks >= state.budget) {
            state.truncated = true;
            return false;
        }
        state.checks += 1;
        return valid(candidate);
    };

    for (let size = 0; size <= Math.min(maxSize, universe.length); size += 1) {
        const combination: string[] = [];
        const walk = (start: number): void => {
            if (found.length >= maxSets || state.checks >= state.budget) return;
            if (combination.length === size) {
                if (covers(combination)) return;
                if (check([...combination])) found.push([...combination]);
                return;
            }
            for (let i = start; i < universe.length; i += 1) {
                if (universe.length - i < size - combination.length) break;
                combination.push(universe[i]);
                walk(i + 1);
                combination.pop();
                if (found.length >= maxSets || state.checks >= state.budget) return;
            }
        };
        walk(0);
        if (found.length >= maxSets) {
            // Es kann weitere geben — das sagen wir, statt es zu verschweigen.
            if (size < Math.min(maxSize, universe.length)) state.truncated = true;
            break;
        }
    }
    if (state.checks >= state.budget) state.truncated = true;
    return found;
}

/**
 * Frontdoor-Kriterium für eine Mediator-Menge Z (Pearl):
 *  (a) Z fängt jeden gerichteten Weg von X nach Y ab,
 *  (b) X und Z haben keinen offenen Hintertürweg,
 *  (c) alle Hintertürwege von Z nach Y sind durch X blockiert.
 */
export function isFrontdoorSet(dag: CausalDag, x: string, y: string, set: readonly string[]): boolean {
    if (set.length === 0) return false;
    if (set.includes(x) || set.includes(y)) return false;
    // (a) Ohne Z gibt es keinen gerichteten Weg mehr von X nach Y.
    const without = createDag({
        nodes: dag.nodes.filter(node => !set.includes(node)),
        edges: dag.edges.filter(edge => !set.includes(edge.from) && !set.includes(edge.to)),
    });
    if (without.has(x) && without.has(y) && descendants(without, [x], false).has(y)) return false;
    // (b) im Graphen ohne die von X ausgehenden Kanten ist Z von X getrennt.
    if (!dSeparated(mutilate(dag, { removeOutgoing: [x] }), [x], set, [])) return false;
    // (c) im Graphen ohne die von Z ausgehenden Kanten trennt X die Menge von Y.
    if (!dSeparated(mutilate(dag, { removeOutgoing: set }), set, [y], [x])) return false;
    return true;
}

/**
 * Instrumentvariablen (§7): Z wirkt auf X, aber auf Y nur ÜBER X. Geprüft
 * wird graphisch — bedingte Instrumente bekommen ihre Konditionierungs-
 * menge W mitgeliefert, weil ein Instrument ohne sie keines wäre.
 */
export function findInstruments(
    dag: CausalDag,
    x: string,
    y: string,
    observable: ReadonlySet<string>,
    state: SearchState,
    maxSetSize: number,
    maxSets: number,
): InstrumentView[] {
    const withoutX = mutilate(dag, { removeOutgoing: [x] });
    const belowY = descendants(dag, [y], true);
    const out: InstrumentView[] = [];
    for (const candidate of dag.nodes) {
        if (out.length >= maxSets) {
            state.truncated = true;
            break;
        }
        if (candidate === x || candidate === y || !observable.has(candidate)) continue;
        const universe = dag.nodes.filter(node =>
            node !== x && node !== y && node !== candidate
            && observable.has(node) && !belowY.has(node));
        // Bedingte Instrumente bleiben klein: Eine Konditionierungsmenge,
        // die niemand mehr überblickt, ist als Begründung wertlos.
        const sets = minimalSets(universe, Math.min(maxSetSize, 2), 1, state, given =>
            dConnected(dag, [candidate], [x], given)
            && dSeparated(withoutX, [candidate], [y], given));
        if (sets.length > 0) out.push({ node: candidate, given: sets[0] });
    }
    return out;
}

/**
 * Die Identifikations-Entscheidung. Reihenfolge der Versuche: Adjustierung
 * (die verständlichste Antwort), dann Frontdoor, dann Instrument. Wer
 * nichts findet, sagt warum.
 */
export function identifyEffect(
    dag: CausalDag,
    exposure: string,
    outcome: string,
    options: IdentifyOptions = {},
): IdentificationResult {
    const label = options.label ?? ((node: string) => node);
    const maxSets = options.maxSets ?? DEFAULTS.maxSets;
    const maxSetSize = options.maxSetSize ?? DEFAULTS.maxSetSize;
    const state: SearchState = { checks: 0, budget: options.budget ?? DEFAULTS.budget, truncated: false };
    const observable = new Set(options.observable ?? dag.nodes);

    const base: IdentificationResult = {
        exposure,
        outcome,
        acyclic: true,
        cycle: null,
        zeroEffect: false,
        identifiable: false,
        strategy: 'none',
        adjustmentSets: [],
        adjustmentSetsMinimal: true,
        canonicalSet: null,
        frontdoorSets: [],
        instruments: [],
        missingVariables: [],
        openBackdoorPaths: [],
        truncated: false,
        reason: '',
    };

    if (!dag.has(exposure) || !dag.has(outcome)) {
        return { ...base, reason: 'Ursache oder Wirkung steht nicht im Modell.' };
    }
    if (exposure === outcome) {
        return { ...base, reason: 'Ursache und Wirkung sind dieselbe Größe — dazu gibt es nichts zu identifizieren.' };
    }
    const cycle = findCycle(dag);
    if (cycle) {
        return {
            ...base,
            acyclic: false,
            cycle,
            reason: `Das Modell ist nicht azyklisch: ${cycle.map(label).join(' → ')}. `
                + 'Solange ein Zyklus im Graphen steht, ist keine Aussage über Identifizierbarkeit möglich.',
        };
    }

    const causal = causalPathNodes(dag, exposure, outcome);
    if (!causal.has(outcome)) {
        return {
            ...base,
            zeroEffect: true,
            identifiable: true,
            reason: `Das Modell behauptet keinen Wirkweg von ${label(exposure)} auf ${label(outcome)}. `
                + 'Unter dieser Annahme ist der kausale Effekt null — geschätzt werden muss dafür nichts.',
        };
    }

    const isValid = adjustmentChecker(dag, exposure, outcome);
    const canonicalFull = canonicalAdjustmentSet(dag, exposure, outcome);
    const canonicalValid = isValid(canonicalFull).valid;
    const backdoorPaths = findPaths(dag, exposure, outcome, { limit: 12 });
    const openBackdoorPaths = backdoorPaths.paths.filter(path => path.kind === 'backdoor' && path.open);

    const universe = canonicalFull.filter(node => observable.has(node));
    const minimal = canonicalValid
        ? minimalSets(universe, maxSetSize, maxSets, state, candidate => isValid(candidate).valid)
        : [];
    // Fällt die Suche nach kleinen Mengen aus (weil das Modell viele
    // Störgrößen hat), heißt das NICHT „nicht identifizierbar": Die
    // kanonische Menge ist zulässig, sobald sie zulässig ist — sie ist nur
    // größer als nötig. Das wird gesagt, statt die Antwort zu verweigern.
    const canonicalUsable = canonicalValid && canonicalFull.every(node => observable.has(node));
    const adjustmentSets = minimal.length > 0 ? minimal : canonicalUsable ? [canonicalFull] : [];
    const adjustmentSetsMinimal = minimal.length > 0 || adjustmentSets.length === 0;

    // Welche Variable fehlt? Genau die, ohne die die kanonische Menge
    // ihre Zulässigkeit verliert — und die niemand erfasst. Ist schon die
    // kanonische Menge unzulässig, liegt es NICHT an der Erfassung,
    // sondern an der Struktur; dann wird hier auch niemand beschuldigt.
    const missingVariables = canonicalValid
        ? canonicalFull
            .filter(node => !observable.has(node))
            .filter(node => !isValid(canonicalFull.filter(other => other !== node)).valid)
        : [];

    const mediators = [...causal].filter(node => node !== outcome && observable.has(node)).sort();
    const frontdoorSets = adjustmentSets.length === 0
        ? minimalSets(mediators, maxSetSize, maxSets, state, candidate =>
            isFrontdoorSet(dag, exposure, outcome, candidate))
        : [];

    const instruments = adjustmentSets.length === 0 && frontdoorSets.length === 0
        ? findInstruments(dag, exposure, outcome, observable, state, maxSetSize, maxSets)
        : [];

    const result: IdentificationResult = {
        ...base,
        canonicalSet: canonicalValid ? canonicalFull : null,
        adjustmentSets,
        adjustmentSetsMinimal,
        frontdoorSets,
        instruments,
        missingVariables,
        openBackdoorPaths,
        truncated: state.truncated || backdoorPaths.truncated,
        reason: '',
    };

    const names = (nodes: readonly string[]) =>
        nodes.length === 0 ? '∅' : nodes.map(label).join(', ');

    if (adjustmentSets.length > 0) {
        const smallest = adjustmentSets[0];
        return {
            ...result,
            identifiable: true,
            strategy: 'backdoor',
            reason: smallest.length === 0
                ? `Kein offener Hintertürweg von ${label(exposure)} nach ${label(outcome)} — `
                    + 'der Effekt ist ohne Adjustierung identifizierbar.'
                : !adjustmentSetsMinimal
                    ? `Identifizierbar durch Adjustierung über alle ${smallest.length} Störgrößen `
                        + '(kanonische Menge). Eine kleinere Menge wurde in der gedeckelten Suche nicht '
                        + 'gefunden — sie kann es geben.'
                    : `Identifizierbar durch Adjustierung über ${names(smallest)}.`
                        + (adjustmentSets.length > 1 ? ` (${adjustmentSets.length} minimale Mengen gefunden.)` : ''),
        };
    }
    if (frontdoorSets.length > 0) {
        return {
            ...result,
            identifiable: true,
            strategy: 'frontdoor',
            reason: `Die Hintertür lässt sich nicht schließen${missingVariables.length > 0
                ? ` (${names(missingVariables)} ${missingVariables.length === 1 ? 'ist' : 'sind'} nicht erfasst)`
                : ''}, aber der Wirkweg über ${names(frontdoorSets[0])} ist vollständig beobachtbar: `
                + 'identifizierbar über das Frontdoor-Kriterium.',
        };
    }
    if (instruments.length > 0) {
        const instrument = instruments[0];
        return {
            ...result,
            identifiable: true,
            strategy: 'iv',
            reason: `Weder Adjustierung noch Frontdoor tragen, aber ${label(instrument.node)} wirkt auf `
                + `${label(exposure)} und auf ${label(outcome)} nur über ${label(exposure)}`
                + `${instrument.given.length > 0 ? ` (gegeben ${names(instrument.given)})` : ''} — `
                + 'identifizierbar über eine Instrumentvariable.',
        };
    }

    if (missingVariables.length > 0) {
        return {
            ...result,
            reason: `Nicht identifizierbar: Zum Schließen der Hintertür wird ${names(missingVariables)} `
                + `gebraucht, ${missingVariables.length === 1 ? 'diese Größe wird' : 'diese Größen werden'} `
                + 'aber nicht erfasst. Ohne Erfassung — oder einen Wirkweg, der ganz beobachtbar ist — '
                + 'bleibt der Effekt unbestimmt.',
        };
    }
    if (!canonicalValid) {
        const blocking = openBackdoorPaths[0];
        return {
            ...result,
            reason: 'Nicht identifizierbar: Es bleibt ein offener Weg zwischen '
                + `${label(exposure)} und ${label(outcome)}, den keine zulässige Menge schließt`
                + (blocking ? ` (${blocking.nodes.map(label).join(' – ')})` : '')
                + '. Adjustieren dürfte man hier nur über Größen, die keine Nachfahren des Wirkwegs sind.',
        };
    }
    return {
        ...result,
        reason: `Nicht identifizierbar mit den gesuchten Mengen (bis Größe ${maxSetSize}). `
            + 'Erfasse mehr Störgrößen oder modelliere den Wirkweg feiner.',
    };
}
