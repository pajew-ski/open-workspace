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
