/**
 * Das Lesemodell eines Kausalmodells — pur (CAUSAL_LAYER_SPEC §5).
 *
 * Diese Typen liegen bewusst NICHT in `model.ts`: Der Editor und die
 * Identifikation laufen im Browser (Abnahme C1), und der Weg dorthin darf
 * nicht über ein Modul führen, das den Store mitzieht. `model.ts`
 * exportiert sie weiter, damit es für den Serverpfad bei einer Adresse
 * bleibt.
 */

/** Vier disjunkte Herkunftsklassen einer kausalen Kante (Invariante C2). */
export const EDGE_CLASSES = ['hypothesis', 'structural', 'learned', 'asserted'] as const;
export type EdgeClass = (typeof EDGE_CLASSES)[number];

/** Belegstand einer Kante (§9 `minEvidence`, Invariante C5). */
export const EVIDENCE_LEVELS = ['hypothesis', 'estimated', 'refuted-clean'] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

/**
 * Der Belegstand ist geordnet: behauptet < geschätzt < refutiert bestanden.
 * `minEvidence` (§9) filtert damit Kanten, ohne dass irgendwo eine zweite
 * Rangfolge entsteht. Eine Kante OHNE Angabe zählt als `hypothesis` — das
 * ist dieselbe Voreinstellung, mit der der Schreibpfad sie anlegt, und die
 * vorsichtigere von beiden (Invariante C5).
 */
export const EVIDENCE_ORDER: Record<EvidenceLevel, number> = {
    hypothesis: 0,
    estimated: 1,
    'refuted-clean': 2,
};

export function meetsEvidence(level: EvidenceLevel | null, minimum: EvidenceLevel): boolean {
    return EVIDENCE_ORDER[level ?? 'hypothesis'] >= EVIDENCE_ORDER[minimum];
}

/**
 * Ein geschätzter und refutierter Effekt an einer Kante (C4). Er steht
 * NIE im Modell-Graphen, sondern im Inferenz-Graphen (Invariante C4) und
 * wird beim Lesen darübergelegt — die Annahme bleibt frei von
 * Ergebnissen, und trotzdem sieht man an der Kante, was aus ihr wurde.
 */
export interface CausalEdgeEffect {
    value: number;
    ciLow: number;
    ciHigh: number;
    standardError?: number;
    unit?: string;
    /** Die Studie, aus der die Zahl stammt (`prov:wasGeneratedBy`). */
    study: string;
}

/**
 * Der Belegstand, der wirklich gilt: die höhere von behaupteter und
 * erwiesener Stufe. Vor C4 war das immer die behauptete — seither hebt
 * eine bestandene Studie die Kante auf `refuted-clean`, ohne dass jemand
 * das Modell anfasst.
 */
export function effectiveEvidence(edge: {
    evidenceLevel: EvidenceLevel | null;
    studyEvidence?: EvidenceLevel | null;
}): EvidenceLevel | null {
    const asserted = edge.evidenceLevel;
    const estimated = edge.studyEvidence ?? null;
    if (asserted === null) return estimated;
    if (estimated === null) return asserted;
    return EVIDENCE_ORDER[estimated] > EVIDENCE_ORDER[asserted] ? estimated : asserted;
}

export interface CausalVariableView {
    iri: string;
    name: string;
    /** Einheit, quelltreu aus der Beobachtungsgröße (schema:unitText). */
    unit?: string;
    /** Ist die Variable dem Modell per schema:hasPart zugeordnet? */
    inModel: boolean;
    /**
     * Erfassung aus `graph/meta` (C3), falls die Variable dort als
     * Beobachtungsgröße geführt wird. Ohne Erfassung ist sie eine reine
     * Modellvariable — zulässig, aber nicht adjustierbar (C1) und später
     * nicht schätzbar (C4).
     */
    observation?: { count: number; from?: string; through?: string };
}

export interface CausalEdgeView {
    from: string;
    to: string;
    /** Reifier der Annotation; fehlt, wenn die Kante unannotiert ist. */
    reifier?: string;
    /** `null`, wenn die Kante keine (oder eine unbekannte) Klasse trägt. */
    edgeClass: EdgeClass | null;
    /** Roher Wert einer unbekannten Klasse — wird angezeigt, nicht geraten. */
    edgeClassRaw?: string;
    evidenceLevel: EvidenceLevel | null;
    evidenceLevelRaw?: string;
    /** ISO-8601-Dauer, quelltreu (`PT15M`). */
    temporalLag?: string;
    /** Belegstand aus einer Studie (C4), getrennt vom behaupteten. */
    studyEvidence?: EvidenceLevel;
    /** Effekt aus einer bestandenen Studie (C4) — nur dann gesetzt (C5). */
    effect?: CausalEdgeEffect;
}

/** Eine Änderung am Modell (C1: `prov:Activity` pro Revision). */
export interface CausalRevisionView {
    iri: string;
    /** Fortlaufende Nummer — die Revision, auf die sich eine Studie beruft. */
    revision: number;
    at?: string;
    /** Wer die Änderung verantwortet (Nutzer-IRI), falls bekannt. */
    actor?: string;
    /** Was geschehen ist, in einem Satz. */
    description: string;
}

export interface CausalModelView {
    id: string;
    iri: string;
    /** Named Graph des Modells — zugleich seine Modellgrenze. */
    graph: string;
    name: string;
    description?: string;
    created?: string;
    modified?: string;
    /** Anzahl bisheriger Änderungen (`schema:version`). */
    revision: number;
    variables: CausalVariableView[];
    edges: CausalEdgeView[];
    /** Änderungsverlauf, neueste zuerst. */
    revisions: CausalRevisionView[];
}
