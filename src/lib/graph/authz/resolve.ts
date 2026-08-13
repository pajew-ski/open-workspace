/**
 * Der eine Punkt, an dem aus einer Identität ein erlaubtes Dataset wird
 * (SPEC §17.3, M13).
 *
 * „Ein einziger Punkt, durch den alle Lesepfade laufen: der
 * Dataset-Resolver." Praktisch heißt das zwei Stufen, die in dieser
 * Reihenfolge greifen:
 *
 *   1. `grantForIdentity` (hier) — Identität + `graph/acl` ⇒ `AccessGrant`
 *      (lesbare, schreibbare, anfügbare, verwaltbare Graphen).
 *   2. `resolveDataset` (SPARQL) bzw. `retrievalDataset` (Retrieval) —
 *      nehmen den Grant als **Verengung** entgegen und injizieren das
 *      Ergebnis in die Query. Kein Nachfilter, kein 403, keine
 *      Existenzbestätigung.
 *
 * Beide Stufen können nur wegnehmen. Ein Pfad, der Stufe 1 überspringt,
 * bekommt kein größeres Dataset, sondern gar keines — Aufrufer ohne Grant
 * gibt es nur dort, wo es keine Identität geben kann (Start, Migration,
 * Reasoner), und die laufen nicht auf Anfragen.
 */

import type { GraphStore } from '../store/types';
import { createIriFactory, describeGraph, DEFAULT_USER_ID, type IriFactory } from '../iri';
import {
    isAclScope,
    matchesProspectiveScope,
    PROSPECTIVE_WRITE_SCOPES,
    resolveWriteGraph,
    scopeMatches,
    type AccessGrant,
} from './grant';
import { graphScopeKey } from './grant';
import { modesFor, type AclAuthorization, type AclMode, type AclPrincipal } from './acl';
import { loadAuthorizations } from './acl-graph';
import { groupsOfUser } from './principals';

export interface AuthzHandle {
    store: GraphStore;
    iri: IriFactory;
}

/** Identität, wie sie aus der Anfrage kommt (M12, `platform/auth`). */
export interface AuthzIdentity {
    userId: string;
    groups: readonly string[];
    authenticated: boolean;
}

/** Anonym — kein Nutzerknoten, keine Gruppen. */
export const ANONYMOUS_IDENTITY: AuthzIdentity = { userId: '', groups: [], authenticated: false };

/**
 * Prinzipal einer Identität: Nutzer-IRI plus Gruppen-IRIs. Gruppen kommen
 * aus ZWEI Quellen, beide gleichwertig — die Mitgliedschaften im Graphen
 * (`foaf:Group`/`foaf:member`) und die Gruppen des Identitätsanbieters
 * (OIDC-Claim, Proxy-Header). Letztere werden auf `<base>group/<name>`
 * abgebildet, damit eine Regel beide erreicht.
 */
export async function principalFor(handle: AuthzHandle, identity: AuthzIdentity): Promise<AclPrincipal> {
    if (!identity.authenticated && identity.userId === '') {
        return { agent: null, groups: [], authenticated: false };
    }
    const fromGraph = await groupsOfUser(handle, identity.userId);
    const fromProvider = identity.groups.map(group => handle.iri.principal('group', group));
    return {
        agent: handle.iri.principal('user', identity.userId),
        groups: [...new Set([...fromGraph, ...fromProvider])].sort(),
        authenticated: identity.authenticated,
    };
}

export interface GrantOptions {
    /** Anzeigename der Identität in PROV/Logs (Token-ID statt Nutzer-ID). */
    label?: string;
    /** Rohes SPARQL erlaubt (UI: ja; MCP-Token: nur mit Recht). */
    sparql?: boolean;
    /** Schreibziel-Scope (`workspace`, `public`, `shared/<id>`). */
    writeScope?: string;
    /**
     * Zusätzliche Verengung durch Scope-Muster (MCP-Token, §7.6). Ein
     * Zugang darf weniger sehen als sein Nutzer, nie mehr.
     */
    narrowTo?: readonly string[];
    /** Bereits geladene Regeln (spart den zweiten Dump pro Anfrage). */
    authorizations?: readonly AclAuthorization[];
    /** Bereits gelesener Graph-Bestand. */
    existingGraphs?: readonly string[];
}

function narrow(iri: IriFactory, graphs: readonly string[], patterns: readonly string[] | undefined): string[] {
    if (!patterns || patterns.length === 0) return [...graphs];
    return graphs.filter(graph => {
        const key = graphScopeKey(iri, graph);
        if (key === null) return false;
        return patterns.some(pattern => scopeMatches(pattern, key));
    });
}

/**
 * Erlaubtes Dataset einer Identität aus `graph/acl`.
 *
 * `graph/acl` selbst ist über keine Regel erreichbar (§3.3) — auch nicht
 * für den Eigentümer. Wer Regeln lesen will, nimmt die Verwaltungs-API,
 * die `control` verlangt; über den Query-Pfad existiert der Graph nicht.
 */
export async function grantForIdentity(
    handle: AuthzHandle,
    identity: AuthzIdentity,
    options: GrantOptions = {},
): Promise<AccessGrant> {
    const existing = options.existingGraphs ?? (await handle.store.graphs()).map(g => g.value);
    const authorizations = options.authorizations ?? (await loadAuthorizations(handle));
    const principal = await principalFor(handle, identity);
    // Scope-Muster („workspace", „import/*") sind relativ zum Nutzer der
    // Identität, nicht zum Nutzer des aufrufenden Handles.
    const userIri = identity.userId === '' || identity.userId === handle.iri.userId
        ? handle.iri
        : createIriFactory(handle.iri.instanceBase, identity.userId || DEFAULT_USER_ID);

    const candidates = existing.filter(graph => {
        const key = graphScopeKey(userIri, graph);
        return key !== null && !isAclScope(key);
    });

    const byMode = (mode: AclMode): string[] =>
        narrow(userIri, candidates.filter(graph => modesFor(authorizations, principal, graph).has(mode)), options.narrowTo).sort();

    const readableGraphs = byMode('read');
    const writableGraphs = byMode('write');
    const appendableGraphs = byMode('append');
    const controlGraphs = byMode('control');

    // Schreibziele aus Scope-Mustern statt aus dem Bestand (C1): Im
    // eigenen Namensraum darf ein Kausalmodell entstehen, obwohl sein
    // Graph noch nicht existiert und deshalb noch keine Regel hat. Die
    // Regel folgt beim ersten Schreibvorgang (`ensureGraphAuthorizations`)
    // und lautet dann genau, was hier vorweggenommen wird: Eigentümer,
    // `control`. Fremde Namensräume und Systemgraphen sind nicht dabei —
    // die Muster tragen die eigene Nutzer-ID im Präfix.
    const ownPrefix = `u/${encodeURIComponent(userIri.userId)}/`;
    const writableScopes = identity.userId === ''
        ? []
        : PROSPECTIVE_WRITE_SCOPES
            // Die Verengung eines Zugangs greift auch hier: Ein Token, das
            // nur `workspace` darf, legt keine Kausalmodelle an.
            .filter(pattern => !options.narrowTo
                || options.narrowTo.some(allowed => scopeMatches(allowed, pattern)))
            .map(pattern => `${ownPrefix}${pattern}`);

    // Das Schreibziel ist erst dann eines, wenn die ACL es hergibt oder
    // der Namensraum dem Anfragenden selbst gehört: ein Scope-Name allein
    // begründet kein Recht.
    let writableGraph: string | null = null;
    if (options.writeScope) {
        const target = resolveWriteGraph(userIri, options.writeScope);
        // Zwei Bedingungen, beide nötig: Die ACL gibt dem Nutzer `write`,
        // UND die Verengung des Zugangs schließt das Ziel ein. Geprüft
        // wird auf dem Muster, nicht auf dem Bestand — ein noch leerer
        // Raum ist ein gültiges Ziel für den ersten Schreibvorgang.
        const withinNarrowing = !options.narrowTo
            || options.narrowTo.some(pattern => scopeMatches(pattern, options.writeScope!));
        const prospective = writableScopes.some(pattern =>
            matchesProspectiveScope(pattern, `${ownPrefix}${options.writeScope}`))
            && !existing.includes(target ?? '');
        if (target && withinNarrowing
            && (prospective || modesFor(authorizations, principal, target).has('write'))) {
            writableGraph = target;
        }
    }

    return {
        identity: options.label ?? identity.userId,
        readableGraphs,
        writableGraph,
        writableScopes,
        sparql: options.sparql ?? false,
        writableGraphs,
        appendableGraphs,
        controlGraphs,
        ...(identity.userId ? { userId: identity.userId } : {}),
    };
}

/**
 * Der Zielgraph, in den eine Identität ihre eigenen Inhalte schreibt.
 * Ohne Schreibrecht auf dem eigenen Workspace-Graphen gibt es keinen —
 * dann schlägt jede Mutation ehrlich fehl, statt woanders zu landen.
 */
export function ownWorkspaceGraph(handle: AuthzHandle): string {
    return handle.iri.graph('workspace');
}

/**
 * Wissens-Graphen einer Graph-Menge (SPEC §7.5): Traversal-Raum des
 * Retrievals über ALLE Nutzer und Räume — `workspace`, `public`,
 * `import/*` jedes Nutzers, `graph/shared/*` und `graph/meta`.
 * Präsentation, Shapes, Vokabular, Inferenz und `acl` sind kein Wissen im
 * Sinne der Pipeline und bleiben draußen; die Rechte-Klammer kommt
 * anschließend über den Grant.
 */
export function knowledgeGraphs(instanceBase: string, existing: readonly string[]): string[] {
    return existing
        .filter(graph => {
            const described = describeGraph(instanceBase, graph);
            if (!described) return false;
            if (described.kind === 'space') return true;
            if (described.kind === 'instance') return described.name === 'meta';
            return described.scope === 'workspace'
                || described.scope === 'public'
                || described.scope.startsWith('import/');
        })
        .sort();
}

/**
 * Darf diese Identität einen Store-weiten Snapshot ausliefern (M13,
 * SPEC §17.4: „Das Git-Backup ist pro Nutzer getrennt oder das Repo ist
 * privat — kein gemeinsames Repo mit gemischten Graphen")?
 *
 * Der `git-backup`-Connector schreibt den kompletten Snapshot in ein
 * Repository. Sobald es mehr als einen Nutzer gibt, wäre das ein Export
 * fremder Graphen über die Hintertür. Die Regel ist deshalb schlicht: Wer
 * den Snapshot ausliefert, muss auf **jedem** darin enthaltenen Graphen
 * `control` haben. Für den Einzelnutzer ist das immer erfüllt.
 *
 * Rückgabe: `null` wenn erlaubt, sonst die Begründung für den Aufrufer.
 */
export function snapshotExportRefusal(
    grant: AccessGrant,
    instanceBase: string,
    existingGraphs: readonly string[],
): string | null {
    const controlled = new Set(grant.controlGraphs ?? []);
    const missing = existingGraphs
        .filter(graph => {
            const described = describeGraph(instanceBase, graph);
            if (!described) return false;
            // Was nicht in den Snapshot geht, ist auch kein Abfluss:
            // vocab/shapes/acl und die Inferenz-Graphen bleiben draußen
            // (serialize/snapshot.ts).
            if (described.kind === 'instance') return described.name === 'meta';
            if (described.kind === 'space') return true;
            return !described.scope.startsWith('inferred/');
        })
        .filter(graph => !controlled.has(graph));
    if (missing.length === 0) return null;
    return 'Ein Git-Backup schreibt den vollständigen Snapshot dieser Installation. '
        + `Dafür fehlt dir die Verwaltung von ${missing.length} Graph(en) — `
        + 'nach SPEC §17.4 darf kein Backup fremde Nutzergraphen mitnehmen. '
        + 'Lass dir „Verwalten" auf den betroffenen Graphen geben oder nutze ein eigenes Repository pro Nutzer.';
}
