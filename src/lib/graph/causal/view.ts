/**
 * Brücke Modell → DAG (Meilenstein C1), pur und browsertauglich.
 *
 * Der Tier-1-Kern (`dag.ts`, `dsep.ts`, `identify.ts`) kennt nur opake
 * Knoten. Hier wird aus dem Lesemodell eines Kausalmodells genau das
 * gemacht, was er braucht: Knoten, Kanten, Beschriftungen — und die
 * Antwort auf die Frage, welche Variablen überhaupt erfasst sind.
 *
 * **Beobachtbar heißt erfasst** (C3): Eine Variable, die im Modell steht,
 * aber keine Beobachtungsreihe hat, kann nicht adjustiert werden. Das ist
 * keine Härte des Werkzeugs, sondern die Lage — und sie wird als solche
 * ausgewiesen, statt eine Adjustierung vorzuschlagen, die niemand rechnen
 * kann.
 */

import { createDag, type CausalDag } from './dag';
import { identifyEffect, type IdentificationResult } from './identify';
import type { CausalModelView } from './types';

export interface ModelDag {
    dag: CausalDag;
    /** Erfasste Variablen (C3) — nur über die lässt sich adjustieren. */
    observable: Set<string>;
    label(node: string): string;
}

export function dagFromModel(model: CausalModelView): ModelDag {
    const labels = new Map(model.variables.map(variable => [variable.iri, variable.name]));
    // Beobachtbar ist, wofür es eine Erfassungsregel gibt (C3) — nicht
    // erst, wofür schon genug Messpunkte da sind. Ob die Reihe lang genug
    // ist, entscheidet die Schätzung (C4); die Identifikation entscheidet,
    // ob überhaupt jemand messen KÖNNTE.
    const observable = new Set(
        model.variables.filter(variable => variable.observation !== undefined).map(variable => variable.iri),
    );
    const dag = createDag({
        nodes: model.variables.map(variable => variable.iri),
        edges: model.edges.map(edge => ({ from: edge.from, to: edge.to })),
    });
    return {
        dag,
        observable,
        label: node => labels.get(node) ?? lastSegment(node),
    };
}

function lastSegment(iri: string): string {
    const withoutFragment = iri.split('#').pop() ?? iri;
    const segment = withoutFragment.split('/').filter(Boolean).pop() ?? withoutFragment;
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

export interface ModelIdentification {
    /** Was der Graph hergibt, wenn jede Modellvariable messbar wäre. */
    structural: IdentificationResult;
    /** Was mit den tatsächlich erfassten Variablen geht (C3). */
    observed: IdentificationResult;
}

/**
 * Beide Sichten in einem Aufruf — und getrennt, weil sie verschiedene
 * Fragen beantworten: „trägt meine Annahme?" und „trägt meine Datenlage?".
 * Sie zu vermischen wäre genau die Scheinpräzision, gegen die §2.2
 * argumentiert.
 */
export function identifyInModel(
    model: CausalModelView,
    exposure: string,
    outcome: string,
): ModelIdentification {
    const { dag, observable, label } = dagFromModel(model);
    return {
        structural: identifyEffect(dag, exposure, outcome, { label }),
        observed: identifyEffect(dag, exposure, outcome, { label, observable }),
    };
}
