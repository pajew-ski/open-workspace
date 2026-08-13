/**
 * Kausale Erdung des Retrievals (CAUSAL_LAYER_SPEC §9, Meilenstein C2).
 *
 * Dieses Modul ist die Naht zwischen dem puren Tier-1-Kern (C1/C2:
 * `causal/{dag,dsep,trace,view}.ts`) und der Retrieval-Pipeline aus
 * GRAPH_CORE_SPEC §7.5. Es tut genau drei Dinge:
 *
 *  1. **Das Modell auflösen** — welcher DAG gilt für diese Frage? Nur
 *     Modelle, die der Aufrufer lesen darf (Grant, §17.3); nie eines
 *     geraten, wenn mehrere in Frage kommen.
 *  2. **Den Trace rechnen** — Vorfahren, Nachfahren, Wege oder
 *     Markov-Kragen, unter der Konditionierung aus `blockedBy`.
 *  3. **Das Ergebnis übersetzen** — kausale Nähe wird zum Seed-Score,
 *     der Weg wird zur Erklärung. Beides deterministisch.
 *
 * Was es NICHT tut: den Graphen anfassen. Es liest, mehr nicht — und es
 * behauptet keinen Effekt (das bleibt C4). Die kausale Kante bleibt
 * fremdes Vokabular (`obo:RO_0002411`, Invariante C8); dieses Modul
 * erfindet dafür nichts Eigenes.
 *
 * **Zur Vorgabe „Default: aktives Modell" (§9).** Ein „aktives Modell"
 * kennt das Datenmodell nicht — es gibt keinen Zustand, der eines
 * auszeichnete, und einen einzuführen wäre eine Spec-Entscheidung. Bis
 * dahin gilt die enge Lesart: Gibt es genau ein lesbares Modell, ist es
 * gemeint. Gibt es mehrere, wird gefragt statt geraten — ein still
 * gewähltes Kausalmodell wäre eine unausgesprochene Annahme, und genau
 * die sollen hier sichtbar sein (Invariante C1).
 */

import {
    traceCausal,
    pathAsText,
    type CausalMode,
    type CausalRole,
    type CausalTraceResult,
} from '../causal/trace';
import { dagFromModel } from '../causal/view';
import { listCausalModels, type GraphHandle } from '../causal/model';
import type { CausalModelView, EvidenceLevel } from '../causal/types';

/** Kausale Steuerung einer Retrieval-Anfrage (§9, wörtlich). */
export interface RetrievalCausal {
    mode: CausalMode;
    /** IRI der Ursache. */
    treatment?: string;
    /** IRI der Wirkung. */
    outcome?: string;
    /** Modell: Kennung, Modell-IRI oder Graph-IRI. Default: das einzige. */
    model?: string;
    /** Konditionierungsmenge — d-separierte Knoten fallen raus. */
    blockedBy?: string[];
    /** Mindest-Belegstand der Kanten. */
    minEvidence?: EvidenceLevel;
}

export type CausalDropReason = 'd-separated' | 'blocked-path' | 'off-chain';

export interface CausalExplainNodeRef {
    iri: string;
    label: string;
}

export interface CausalExplainPath {
    nodes: string[];
    /** Lesbare Kette mit Richtung je Schritt (`A → U ← B`). */
    text: string;
    kind: 'causal' | 'backdoor' | 'other';
    open: boolean;
    /** Knoten, die diesen Weg schließen. */
    blockedBy: string[];
}

/** Der kausale Teil von `explain` (§9: „`explain` trägt den kausalen Pfad"). */
export interface RetrievalCausalExplain {
    mode: CausalMode;
    model?: { id: string; iri: string; graph: string; name: string; revision: number };
    treatment?: CausalExplainNodeRef;
    outcome?: CausalExplainNodeRef;
    conditionedOn: CausalExplainNodeRef[];
    minEvidence?: EvidenceLevel;
    /** Wege zwischen Ursache und Wirkung, offen wie geschlossen. */
    paths: CausalExplainPath[];
    /** Was herausgefallen ist — mit Namen und Grund. */
    dropped: Array<CausalExplainNodeRef & { reason: CausalDropReason }>;
    /** Kanten, die `minEvidence` nicht erreicht haben. */
    droppedEdges: number;
    /** Pfad-Aufzählung gedeckelt? Dann ist `paths` unvollständig. */
    truncated: boolean;
    notes: string[];
}

export interface CausalSeed {
    score: number;
    distance: number;
    role: CausalRole;
    /** Weg vom Bezugsknoten hierher (Knotenfolge). */
    path: string[];
}

export interface CausalGrounding {
    /** Konnte ein Modell aufgelöst und ein Trace gerechnet werden? */
    grounded: boolean;
    /** Named Graph des Modells — er kommt zum Traversal-Raum dazu. */
    modelGraph: string | null;
    /** Kausale Seeds mit Nähe als Score (1 = der Bezugsknoten selbst). */
    seeds: Map<string, CausalSeed>;
    /**
     * ALLE Variablen des Modells. Was hier drinsteht, aber nicht in
     * `seeds`, ist eine Modellgröße ohne Bezug zur Frage — die Expansion
     * lässt sie nicht durch (das ist die Kette statt der Wolke).
     */
    modelVariables: Set<string>;
    /**
     * Buchhaltung des Modells: seine Revisionen (`prov:Activity`). Sie
     * hängen am Modell-Knoten und wären über ihn zwei Hops von jeder
     * Variablen entfernt — ein Kontext aus zwanzigmal „Kante hinzugefügt"
     * statt aus Wissen. Sie gehören zur Herkunft des Modells (sichtbar
     * unter `/graph/causal`), nicht zur Antwort auf eine kausale Frage,
     * und die Expansion lässt sie deshalb nicht durch.
     */
    bookkeeping: Set<string>;
    label(node: string): string;
    explain: RetrievalCausalExplain;
}

function round6(value: number): number {
    return Math.round(value * 1e6) / 1e6;
}

/**
 * Kausale Nähe als Score in (0, 1]: der Bezugsknoten selbst zählt voll,
 * jeder Schritt entlang der kausalen Kette verdünnt. Das ist die Stelle,
 * an der §9 „kausale Nähe statt Kosinus-Ähnlichkeit" konkret wird —
 * gewichtet wird der Weg im DAG, nicht die Wortähnlichkeit.
 */
export function causalProximity(distance: number): number {
    return round6(1 / (1 + Math.max(0, distance)));
}

function resolveModel(models: readonly CausalModelView[], wanted: string | undefined): {
    model: CausalModelView | null;
    note?: string;
} {
    if (models.length === 0) {
        return { model: null, note: 'Es gibt kein lesbares Kausalmodell — ohne Modell keine kausale Erdung.' };
    }
    if (!wanted) {
        if (models.length === 1) return { model: models[0] };
        return {
            model: null,
            note: 'Mehrere Kausalmodelle vorhanden — welches gilt, muss gesagt werden: '
                + `${models.map(model => model.id).join(', ')}.`,
        };
    }
    const found = models.find(model => model.id === wanted || model.iri === wanted || model.graph === wanted);
    if (found) return { model: found };
    return { model: null, note: `Kausalmodell „${wanted}" ist nicht vorhanden oder nicht lesbar.` };
}

function emptyGrounding(mode: CausalMode, notes: string[], causal: RetrievalCausal): CausalGrounding {
    return {
        grounded: false,
        modelGraph: null,
        seeds: new Map(),
        modelVariables: new Set(),
        bookkeeping: new Set(),
        label: node => node,
        explain: {
            mode,
            conditionedOn: [],
            ...(causal.minEvidence ? { minEvidence: causal.minEvidence } : {}),
            paths: [],
            dropped: [],
            droppedEdges: 0,
            truncated: false,
            notes,
        },
    };
}

export interface CausalGroundingOptions {
    /** Verengung durch den Grant (§17.3) — kann nur wegnehmen. */
    allowedGraphs?: readonly string[];
}

/**
 * Erdung einer Anfrage im Kausalmodell. Schlägt sie fehl, ist das
 * Ergebnis `grounded: false` mit Begründung — nicht ein stilles Zurück
 * auf semantisches Retrieval. Wer kausalen Kontext bestellt hat, soll
 * keinen bekommen, der bloß so aussieht (Invariante 10).
 */
export async function groundCausal(
    handle: GraphHandle,
    causal: RetrievalCausal,
    options: CausalGroundingOptions = {},
): Promise<CausalGrounding> {
    const models = await listCausalModels(handle, {
        ...(options.allowedGraphs ? { allowedGraphs: options.allowedGraphs } : {}),
    });
    const resolved = resolveModel(models, causal.model);
    if (!resolved.model) {
        return emptyGrounding(causal.mode, resolved.note ? [resolved.note] : [], causal);
    }
    const model = resolved.model;
    const { dag, label, droppedByEvidence } = dagFromModel(model, {
        ...(causal.minEvidence ? { minEvidence: causal.minEvidence } : {}),
    });
    const trace = traceCausal(dag, {
        mode: causal.mode,
        ...(causal.treatment ? { treatment: causal.treatment } : {}),
        ...(causal.outcome ? { outcome: causal.outcome } : {}),
        ...(causal.blockedBy ? { blockedBy: causal.blockedBy } : {}),
    });

    const notes = [...trace.notes];
    if (droppedByEvidence.length > 0) {
        notes.push(
            `${droppedByEvidence.length} Kante(n) erreichen den Belegstand „${causal.minEvidence}" nicht `
            + 'und bleiben außen vor. Geschätzte Kanten entstehen erst mit der Schätzung (C4) — '
            + 'bis dahin ist jede Kante eine Annahme.',
        );
    }

    const seeds = new Map<string, CausalSeed>();
    for (const node of trace.nodes) {
        seeds.set(node.node, {
            score: causalProximity(node.distance),
            distance: node.distance,
            role: node.role,
            path: node.path,
        });
    }
    if (seeds.size === 0 && notes.length === 0) {
        notes.push('Der Trace hat im Modell nichts gefunden, was zu dieser Frage gehört.');
    }

    return {
        grounded: seeds.size > 0,
        modelGraph: model.graph,
        seeds,
        modelVariables: new Set(model.variables.map(variable => variable.iri)),
        bookkeeping: new Set(model.revisions.map(revision => revision.iri)),
        label,
        explain: buildExplain(model, causal, trace, label, droppedByEvidence.length, notes),
    };
}

function buildExplain(
    model: CausalModelView,
    causal: RetrievalCausal,
    trace: CausalTraceResult,
    label: (node: string) => string,
    droppedEdges: number,
    notes: string[],
): RetrievalCausalExplain {
    const ref = (iri: string): CausalExplainNodeRef => ({ iri, label: label(iri) });
    return {
        mode: trace.mode,
        model: {
            id: model.id,
            iri: model.iri,
            graph: model.graph,
            name: model.name,
            revision: model.revision,
        },
        ...(trace.treatment ? { treatment: ref(trace.treatment) } : {}),
        ...(trace.outcome ? { outcome: ref(trace.outcome) } : {}),
        conditionedOn: trace.conditioned.map(ref),
        ...(causal.minEvidence ? { minEvidence: causal.minEvidence } : {}),
        paths: trace.paths.map(path => ({
            nodes: [...path.nodes],
            text: pathAsText(path, label),
            kind: path.kind,
            open: path.open,
            blockedBy: [...path.blockedBy],
        })),
        dropped: trace.dropped.map(entry => ({ ...ref(entry.node), reason: entry.reason })),
        droppedEdges,
        truncated: trace.truncated,
        notes,
    };
}
