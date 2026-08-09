/**
 * Connector-Vertrag (SPEC §6.1) — EIN Interface für alles Externe
 * (Invariante 5): GitHub-RDF, Obsidian-Vault, JSON-Canvas, A2A-Card,
 * MCP-Resource, SPARQL-Endpoint und das eigene Git-Backup-Repo sind
 * Instanzen desselben Vertrags. Kein Feature bekommt eine Sonderpipeline.
 *
 * Regeln (SPEC §6.2):
 *  - Materialisierende Connectors schreiben ausschließlich in
 *    `graph/<u>/import/<connectorId>`, immer mit `replace: true`.
 *  - Föderierende Connectors schreiben nichts; sie registrieren nur einen
 *    Endpoint in `graph/meta`.
 *  - Jeder Lauf schreibt PROV-Tripel (wasDerivedFrom, generatedAtTime,
 *    wasAttributedTo, ow:revision) — das erledigt der Runner (sync.ts)
 *    einheitlich, nicht jeder Connector einzeln.
 *  - `push` läuft grundsätzlich über Branch → Commit → Pull Request;
 *    Direct-Write nur nach expliziter Freigabe pro Instanz.
 *
 * Fehlertoleranz (M3-Abnahme): Ein Import scheitert NIE an der Qualität
 * der Quelle. Was parst, wird importiert; der Rest landet über
 * `ctx.quarantine()` im Fehlerbericht und wird in der UI gemeldet.
 * Unbekannte Prädikate und fehlende Typen sind kein Fehler — es gibt
 * keine Vokabular-Schranke am Import. SHACL validiert ab M7 berichtend,
 * nicht blockierend (SPEC §7.2).
 */

import type { Quad } from '@rdfjs/types';
import type { GraphStore } from '../store/types';
import type { IriFactory } from '../iri';
import type { FileSystemLike, RuntimeAdapter } from '@/lib/platform/runtime/types';

export type ConnectorMode = 'materialize' | 'federate';

export interface SourceRef {
    /** Stabile Connector-Instanz-ID (auch Named-Graph-Suffix). */
    id: string;
    kind: string;
    /** Repo-URL, Vault-Pfad, SPARQL-Endpoint, Agent-Card-URL. */
    locator: string;
    /** commit-sha | etag | inhalts-hash — Grundlage der No-Op-Erkennung. */
    revision?: string;
    /** xsd:dateTime */
    fetchedAt?: string;
}

/** Eine quarantänierte Quell-Einheit (Datei, Zeile, Segment). */
export interface QuarantineEntry {
    /** Quell-Bezeichnung, z. B. Dateipfad oder `datei.nq:12` (Zeile). */
    source: string;
    /** Menschlich lesbare Begründung (deutsch). */
    reason: string;
}

export interface ConnectorContext {
    store: GraphStore;
    iri: IriFactory;
    signal: AbortSignal;
    /**
     * Netzwerkzugriff des Connectors — vom Runner mit SSRF-Schutz,
     * Redirect-Validierung, Timeout und Größenlimit ummantelt
     * (http.ts). Connectors rufen nie das globale `fetch` direkt.
     */
    fetch: (url: string, init?: RequestInit) => Promise<Response>;
    report(progress: { done: number; total?: number; note?: string }): void;
    /** Meldet eine nicht importierbare Quell-Einheit (Fehlerbericht). */
    quarantine(entry: QuarantineEntry): void;
    /**
     * Dateizugriff der Runtime (SPEC §5.2, `files()` des RuntimeAdapters).
     * Vom Aufrufer injiziert (Server: node:fs, Tests: Memory-FS); Connectors
     * mit Dateiquellen (obsidian-vault) verlangen ihn und scheitern sonst
     * mit einem Infrastrukturfehler — nie stillschweigend.
     */
    files?: FileSystemLike;
    /**
     * Runtime-Adapter (SPEC §5.2). Optional, bis die Adapter-
     * Implementierungen existieren (M6/M12) — rdf-file und github-rdf
     * brauchen nur `fetch`. Keine Platzhalter-Adapter (Invariante 10).
     */
    runtime?: RuntimeAdapter;
}

export interface QuadDelta {
    added: Quad[];
    removed: Quad[];
}

export interface WriteReceipt {
    mode: 'direct' | 'pull-request';
    /** html_url bei PR. */
    url?: string;
    revision: string;
}

export interface AuthHint {
    kind: 'none' | 'bearer' | 'basic';
    /** Schlüssel im SecretStore der Runtime, nie das Secret selbst. */
    secretRef?: string;
}

export interface ConflictReport {
    sourceRevision: string;
    lastPulledRevision?: string;
    conflicts: Array<{ path?: string; reason: string }>;
}

/**
 * Revisionskonflikt beim `push` (SPEC §6.2): Die Quelle wurde seit dem
 * letzten `pull` extern verändert — Schreiben ohne vorheriges `reconcile`
 * bzw. erneutes Synchronisieren ist verboten. Der Runner übersetzt diesen
 * Fehler in den Sync-Zustand `conflict` statt `error`.
 */
export class ConnectorConflictError extends Error {
    constructor(message: string, readonly report: ConflictReport) {
        super(message);
        this.name = 'ConnectorConflictError';
    }
}

/** JSON Schema der Connector-Konfiguration (z. B. via z.toJSONSchema). */
export type JSONSchema = Record<string, unknown>;

export interface Connector<TConfig = unknown> {
    readonly kind: string;
    readonly mode: ConnectorMode;
    readonly capabilities: {
        read: boolean;
        write: boolean;
        watch: boolean;
        lossyExport: boolean;
    };
    /** Anzeigename und Kurzbeschreibung für die UI (deutsch). */
    readonly label: string;
    readonly description: string;

    configSchema(): JSONSchema;
    /** Validiert unbekannten Input zur typisierten Konfiguration. */
    parseConfig(input: unknown): TConfig;

    /**
     * Instanzen persistieren als Graph-Knoten mit `ow:locator`
     * (Invariante 6), nicht als JSON-Datei — deshalb muss die
     * Konfiguration verlustfrei in den Locator-String und zurück:
     * `configFromLocator(locatorFor(config))` ≙ `config`.
     */
    locatorFor(config: TConfig): string;
    configFromLocator(locator: string): TConfig;

    /**
     * Prüft Erreichbarkeit und bestimmt die aktuelle Revision der Quelle,
     * ohne zu importieren. Grundlage der No-Op-Entscheidung des Runners.
     */
    probe(config: TConfig, ctx: ConnectorContext): Promise<SourceRef>;

    /** mode === 'materialize': liefert die Quads der Quelle. */
    pull?(ref: SourceRef, ctx: ConnectorContext): AsyncIterable<Quad>;

    /** mode === 'federate': registriert nur einen Endpoint. */
    endpoint?(ref: SourceRef): { url: string; auth?: AuthHint };

    /** Optional, bidirektional (Branch → Commit → PR, SPEC §6.2). */
    push?(ref: SourceRef, delta: QuadDelta, ctx: ConnectorContext): Promise<WriteReceipt>;
    reconcile?(ref: SourceRef, ctx: ConnectorContext): Promise<ConflictReport>;
}

/** Betriebszustand laut Ontologie (`ow:syncState`). */
export type ConnectorSyncState = 'idle' | 'syncing' | 'error' | 'conflict';

/** Lesemodell einer Connector-Instanz aus `graph/meta`. */
export interface ConnectorInstanceView {
    id: string;
    iri: string;
    name: string;
    kind: string;
    locator: string;
    targetGraph: string;
    syncState: ConnectorSyncState;
    /** Revision des letzten erfolgreichen Imports. */
    revision?: string;
    createdAt?: string;
    modifiedAt?: string;
    lastRun?: {
        at?: string;
        revision?: string;
        summary?: string;
        errors: string[];
    };
}

export interface SyncResult {
    connectorId: string;
    status: 'noop' | 'imported' | 'failed';
    revision?: string;
    previousRevision?: string;
    /** Quads im Import-Graphen nach dem Lauf (inkl. PROV). */
    added: number;
    /** Beim Replace entfernte Quads. */
    removed: number;
    quarantined: QuarantineEntry[];
    /** Menschlich lesbare Zusammenfassung (deutsch). */
    message: string;
    finishedAt: string;
}
