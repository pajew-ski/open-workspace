/**
 * Beobachtungsgrößen und ihre Erfassung (CAUSAL_LAYER_SPEC §5/§6).
 *
 * Die Trennung, auf der alles Weitere steht (Invariante C3): Der Graph
 * trägt die **Definition** einer Größe — was sie ist, woraus sie kommt,
 * wie verdichtet, bis wann erfasst. Die **Werte** liegen daneben im
 * Beobachtungs-Speicher (`store.ts`) und werden nie zu Tripeln. Eine
 * Reihe mit Millionen Punkten wäre als RDF unbrauchbar; gelesen wird sie
 * ohnehin nie per SPARQL, sondern spaltenweise von einem Schätzer.
 */

/** Skalenniveau — entscheidet, welche Verdichtung zulässig ist. */
export type ObservationKind = 'numeric' | 'binary' | 'categorical';

/** Verdichtung der Rohwerte auf das Abtastraster. */
export type Aggregation = 'last' | 'mean' | 'min' | 'max' | 'sum';

/** Betriebszustand der Erfassung (ow:captureState). */
export type CaptureState = 'idle' | 'capturing' | 'error';

/**
 * Zulässige Verdichtungen je Skalenniveau. Ein Mittelwert über
 * Schalterzustände ist keine Näherung, sondern eine Falschaussage —
 * deshalb ist die Kombination validiert und nicht bloß dokumentiert.
 */
export const ALLOWED_AGGREGATIONS: Readonly<Record<ObservationKind, ReadonlyArray<Aggregation>>> = {
    numeric: ['last', 'mean', 'min', 'max', 'sum'],
    binary: ['last', 'max', 'mean'],
    categorical: ['last'],
};

/**
 * Ein Messpunkt. `v` ist null, wenn die Quelle den Zustand als
 * unbekannt/nicht verfügbar gemeldet hat — die Lücke wird **erfasst**,
 * nicht verschwiegen: fehlende Werte sind selten zufällig fehlend, und
 * eine stillschweigend übersprungene Lücke verzerrt jede spätere
 * Schätzung, ohne sichtbar zu sein.
 */
export interface Observation {
    /** Zeitstempel in Millisekunden seit Epoch (UTC). */
    t: number;
    v: number | string | null;
    /** Grund einer Lücke, quelltreu ('unavailable', 'unknown'). */
    q?: string;
}

/** Definition einer erfassten Größe — der Graph-Anteil. */
export interface VariableDefinition {
    /** Stabile ID, zugleich Verzeichnisname im Beobachtungs-Speicher. */
    id: string;
    name: string;
    /** Art der Quelle; heute nur `home-assistant`. */
    sourceKind: string;
    /** Quellschlüssel, quelltreu (HA: die entity_id). */
    source: string;
    kind: ObservationKind;
    aggregation: Aggregation;
    /** Abtastabstand in Sekunden. */
    intervalSeconds: number;
    unit?: string;
    /** Ort der Quelle als IRI (Bereich), falls die Struktur ihn kennt. */
    placeIri?: string;
    /** Mess-Knoten der Quelle als IRI (sosa:Sensor), falls vorhanden. */
    sensorIri?: string;
    enabled: boolean;
    /** 0 = unbegrenzt (Default). */
    retentionDays: number;
}

/**
 * Die aus Aggregaten nachgefüllte Strecke des Bestands (§15.5).
 *
 * Sie steht getrennt vom übrigen Zustand, weil sie eine andere Aussage
 * macht: Hier liegen keine erfassten Zustandswechsel, sondern
 * Stundenmittel aus den Long-Term-Statistics. Ohne diese Angabe sähe der
 * Bestand vor und nach der Grenze gleich aus, obwohl er es nicht ist.
 */
export interface AggregateCoverage {
    /** Ältester Punkt aus Aggregaten (ISO). */
    from: string;
    /** Jüngster Punkt aus Aggregaten (ISO). */
    through: string;
    /** Tatsächliche Auflösung dieser Strecke in Sekunden (Statistik: 3600). */
    intervalSeconds: number;
    /** Letzter Rückgriff: Zeitpunkt und Zusammenfassung (deutsch). */
    at?: string;
    summary?: string;
}

/** Erfassungszustand — liegt in `graph/meta`, nicht beim Wissen. */
export interface CaptureStatus {
    state: CaptureState;
    /** Ältester gehaltener Messpunkt (ISO). */
    capturedFrom?: string;
    /** Wasserzeichen: jüngster übernommener Messpunkt (ISO). */
    capturedThrough?: string;
    count: number;
    lastRun?: {
        at: string;
        summary: string;
        errors: string[];
    };
    /** Aus Aggregaten nachgefüllte Strecke, falls es eine gibt. */
    aggregate?: AggregateCoverage;
}

export interface VariableView extends VariableDefinition {
    iri: string;
    status: CaptureStatus;
}

/** Ergebnis eines Erfassungslaufs für genau eine Größe. */
export interface CaptureResult {
    variableId: string;
    status: 'captured' | 'noop' | 'failed' | 'skipped';
    /** Neu angehängte Messpunkte. */
    appended: number;
    /** Beim Aufräumen nach Aufbewahrungsfrist entfernte Messpunkte. */
    pruned: number;
    /** Erfasstes Fenster (ISO), auch bei 0 neuen Punkten. */
    from?: string;
    through?: string;
    /** true, wenn dieser Lauf den erstmaligen Rückgriff auf die Quelle war. */
    backfill: boolean;
    message: string;
}
