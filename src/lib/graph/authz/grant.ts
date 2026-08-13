/**
 * Zugriffs-Grant: erlaubtes Dataset einer Identität (SPEC §7.6, Vorstufe
 * von §17.3).
 *
 * M10 braucht das, was M13 vollständig ausbaut: „Ein MCP-Token ist an eine
 * Identität und deren erlaubtes Dataset gebunden. Der MCP-Server sieht nie
 * mehr als der Nutzer, dessen Token er trägt." Damit das kein zweiter
 * Sicherheitspfad neben SPARQL und Retrieval wird, ist der Grant nichts
 * weiter als eine **Verengung** der bestehenden Dataset-Auflösung:
 *
 *   resolveDataset(...)   (SPARQL, §7.1) — akzeptiert `allowedGraphs`
 *   retrievalDataset(...) (Retrieval, §7.5) — akzeptiert `allowedGraphs`
 *
 * Beide klammern das Dataset weiterhin selbst; der Grant kann nur
 * wegnehmen, nie hinzufügen. Ein Aufrufer ohne Grant (UI, lokale Routen)
 * verhält sich unverändert.
 *
 * Dieses Modul ist pur: es kennt weder Store noch Umgebung — es bildet
 * Scope-Muster auf die real vorhandenen Named Graphs ab (§3.3).
 *
 * Mit M13 ist der Wechsel vollzogen: Die Herkunft der Liste sind die
 * ACL-Regeln aus `graph/acl` (`resolve.ts`), nicht mehr die Scope-Muster
 * der Token-Konfiguration. Die Schnittstelle blieb dabei dieselbe — eine
 * Identität, eine Liste erlaubter Graph-IRIs, ein Schreibziel —, weshalb
 * MCP-Server (M10) und eingehende Föderation (M11) unverändert
 * weiterlaufen. Die Scope-Muster leben weiter als **zusätzliche
 * Verengung** eines Tokens (ein Zugang darf weniger dürfen als sein
 * Nutzer, nie mehr).
 */

import type { IriFactory } from '../iri';

export interface AccessGrant {
    /** Identität, an die der Zugriff gebunden ist (Token-ID bzw. Nutzer). */
    identity: string;
    /** Erlaubte Named Graphs als absolute IRIs. Leer = nichts sichtbar. */
    readonly readableGraphs: readonly string[];
    /** Zielgraph für Schreibzugriffe; null = kein Schreibrecht. */
    readonly writableGraph: string | null;
    /** Rohe SPARQL-Queries (read-only) erlaubt? */
    readonly sparql: boolean;
    /** M13: alle Graphen mit `acl:Write` (SPARQL UPDATE, CRUD). */
    readonly writableGraphs?: readonly string[];
    /** M13: alle Graphen mit `acl:Append` (beitragen, nicht löschen). */
    readonly appendableGraphs?: readonly string[];
    /** M13: alle Graphen mit `acl:Control` (Freigaben verwalten). */
    readonly controlGraphs?: readonly string[];
    /** M13: Nutzer-ID hinter der Identität (Token → Nutzer). */
    readonly userId?: string;
    /**
     * C1: Scope-Muster im EIGENEN Namensraum, in denen ein noch nicht
     * existierender Graph angelegt werden darf (`u/<id>/causal/*`). Sie
     * gelten ausschließlich für neue Graphen — was es schon gibt,
     * entscheidet `writableGraphs` aus `graph/acl` und sonst nichts.
     * Notiert base-relativ wie `graphScope` in `sparql/protocol.ts`.
     */
    readonly writableScopes?: readonly string[];
}

/**
 * Scope-Schlüssel eines Named Graphs — die Form, in der Grants notiert
 * werden: `workspace`, `public`, `presentation`, `import/<id>`,
 * `inferred/<scope>` (nutzerskaliert, §3.3) sowie `meta`, `vocab`,
 * `shapes`, `shared/<id>` (instanzweit). Fremde Nutzergraphen behalten
 * ihren vollen Pfad (`u/<id>/workspace`) und sind damit nur über `*`
 * adressierbar — im Single-User-Betrieb existieren sie nicht.
 *
 * `null` für alles, was nicht unter `<base>graph/` liegt.
 */
export function graphScopeKey(iri: IriFactory, graph: string): string | null {
    const userPrefix = iri.importGraph('').slice(0, -'import/'.length);
    if (graph.startsWith(userPrefix)) return graph.slice(userPrefix.length);
    const sharedPrefix = `${iri.instanceBase}graph/`;
    if (graph.startsWith(sharedPrefix)) return graph.slice(sharedPrefix.length);
    return null;
}

/** `graph/acl` ist aus JEDEM Dataset ausgeschlossen (SPEC §3.3). */
export function isAclScope(scopeKey: string): boolean {
    return scopeKey === 'acl';
}

/**
 * Prüft ein Scope-Muster gegen einen Scope-Schlüssel. Erlaubt sind exakte
 * Schlüssel (`workspace`, `import/prima-materia`), Präfix-Wildcards
 * (`import/*`, `inferred/*`, `shared/*`) und `*` für „alles Lesbare".
 * `acl` wird von keinem Muster getroffen, auch nicht von `*`.
 */
export function scopeMatches(pattern: string, scopeKey: string): boolean {
    if (isAclScope(scopeKey)) return false;
    if (pattern === '*') return true;
    if (pattern.endsWith('/*')) return scopeKey.startsWith(pattern.slice(0, -1));
    return pattern === scopeKey;
}

/**
 * Bildet Scope-Muster auf die real vorhandenen Graphen ab. Nicht
 * vorhandene Graphen erzeugen keinen Eintrag — ein Grant beschreibt
 * Rechte, keine Existenz.
 */
export function resolveGrantGraphs(
    iri: IriFactory,
    patterns: readonly string[],
    existingGraphs: readonly string[],
): string[] {
    const graphs = existingGraphs.filter(graph => {
        const key = graphScopeKey(iri, graph);
        if (key === null || isAclScope(key)) return false;
        return patterns.some(pattern => scopeMatches(pattern, key));
    });
    return [...new Set(graphs)].sort();
}

/**
 * Schreibziele sind bewusst eng (SPEC §3.3): der eigene Workspace-Graph
 * („UI, Agent, API des Eigentümers"), geteilte Räume — und seit C1 der
 * eigene Kausal-Namensraum. Alles andere ist systemverwaltet —
 * Import-Graphen gehören ihrem Connector, `inferred` dem Reasoner,
 * `meta`/`vocab`/`shapes`/`acl` der Installation, `presentation` der
 * Canvas-UI.
 *
 * **Warum der Kausal-Namensraum dazugehört** (CAUSAL_LAYER_SPEC §5.1):
 * Ein Kausalmodell IST sein Named Graph. Wer ein Modell anlegt, legt
 * einen Graphen an — und das ist kein Systemvorgang, sondern der
 * Normalfall der Kausal-Arbeit. Ohne diesen Scope hätten DAG-Editor,
 * CRUD und SPARQL-Editor drei verschiedene Schreibwege, von denen nur
 * einer funktioniert.
 */
export function resolveWriteGraph(iri: IriFactory, scope: string): string | null {
    if (scope === 'workspace') return iri.graph('workspace');
    if (scope === 'public') return iri.graph('public');
    if (scope === 'causal-hypotheses') return iri.graph('causal-hypotheses');
    if (scope.startsWith('shared/')) {
        const spaceId = scope.slice('shared/'.length);
        return spaceId === '' || spaceId.includes('/') ? null : iri.spaceGraph(spaceId);
    }
    if (scope.startsWith('causal/')) {
        const modelId = scope.slice('causal/'.length);
        return modelId === '' || modelId.includes('/') ? null : iri.causalGraph(modelId);
    }
    return null;
}

/** Menschenlesbare Begründung für abgelehnte Schreib-Scopes (UI/Fehler). */
export const WRITE_SCOPE_HINT =
    'Erlaubte Schreibziele: "workspace", "public", "shared/<raum-id>", ' +
    '"causal/<modell-id>" oder "causal-hypotheses". ' +
    'Import-, Inferenz-, Präsentations- und Systemgraphen sind systemverwaltet.';

/**
 * Muster im eigenen Namensraum, in denen ein NEUER Graph entstehen darf
 * (C1). Sie sind die verallgemeinerte Fassung der Ausnahme, die
 * `bootstrapAccess` für `workspace`/`public`/`presentation` von Hand
 * macht: Deren Regeln lassen sich vorab anlegen, weil es endlich viele
 * sind. Kausalmodelle sind unbegrenzt viele — ihre Standardregel
 * (Eigentümer, `control`) entsteht deshalb erst mit dem Graphen
 * (`ensureGraphAuthorizations`), und bis dahin steht hier, dass der
 * Eigentümer seinen eigenen Namensraum füllen darf.
 *
 * Die Muster gelten NUR für Graphen, die es noch nicht gibt. Für alles
 * Vorhandene bleibt `graph/acl` die einzige Quelle — ein entzogenes
 * Schreibrecht wird dadurch nicht wieder aufgemacht.
 */
export const PROSPECTIVE_WRITE_SCOPES = ['causal/*', 'causal-hypotheses'] as const;

/**
 * Trifft ein Muster aus `PROSPECTIVE_WRITE_SCOPES` diesen base-relativen
 * Graph-Schlüssel (`u/<id>/causal/<modell>`)? Anders als `scopeMatches`
 * erlaubt `…/*` hier genau EIN weiteres Segment: `causal/a/b` wäre kein
 * Modell, und ein Muster darf nicht mehr aufmachen, als es benennt.
 */
/**
 * Darf diese Identität den Graphen ANLEGEN? Die Frage stellt sich nur für
 * Graphen, die es noch nicht gibt — für vorhandene entscheidet
 * `writableGraphs` aus `graph/acl`. Sie ist damit dieselbe Prüfung, die
 * der Update-Schutz in `sparql/protocol.ts` macht, nur für die Routen.
 */
export function mayCreateGraph(grant: AccessGrant, instanceBase: string, graph: string): boolean {
    const prefix = `${instanceBase}graph/`;
    if (!graph.startsWith(prefix)) return false;
    const key = graph.slice(prefix.length);
    return (grant.writableScopes ?? []).some(pattern => matchesProspectiveScope(pattern, key));
}

export function matchesProspectiveScope(pattern: string, scopeKey: string): boolean {
    if (isAclScope(scopeKey)) return false;
    if (!pattern.endsWith('/*')) return pattern === scopeKey;
    const prefix = pattern.slice(0, -1);
    if (!scopeKey.startsWith(prefix)) return false;
    const rest = scopeKey.slice(prefix.length);
    return rest !== '' && !rest.includes('/');
}
