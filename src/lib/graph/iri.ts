/**
 * IRI-Strategie (SPEC §3.2, §3.3).
 *
 * Drei strikt getrennte Basen:
 *  1. Vokabular-Base — konstant, siehe vocab.ts
 *  2. Erweiterungs-Base `<deploymentBase>/ns/ext#` — pro Deployment
 *  3. Instanz-Base — pro Installation, hier verwaltet
 *
 * Dieses Modul ist pur: Es kennt weder Dateisystem noch Umgebung. Die
 * Auflösung der Instanz-Base (Env, persistierte Datei, UUID-Erzeugung)
 * übernimmt der Runtime-Adapter.
 */

import { OWL } from './vocab';

/** Fester Default-Nutzer für die Runtimes `local` und `ha-addon` (SPEC §3.3). */
export const DEFAULT_USER_ID = 'default';

export type EntityType =
    | 'doc'
    | 'project'
    | 'task'
    | 'canvas'
    | 'card'
    | 'tag'
    | 'skill'
    | 'agent'
    | 'tool'
    | 'tool-provider'
    | 'connector'
    | 'endpoint'
    | 'person'
    /** Kalender: abonnierte Quelle (schema:DataFeed) und ihre Termine. */
    | 'calendar'
    | 'event'
    | 'conversation'
    | 'message'
    /** AI-Konfiguration im Spiegel `graph/meta` (M15). */
    | 'ai-provider'
    | 'model'
    | 'query'
    | 'activity'
    /** Reifier-Knoten einer annotierten Kante (RDF 1.2, rdf:reifies). */
    | 'link'
    /** Layout-Elemente in graph/presentation (SPEC §9 / M5). */
    | 'canvas-node'
    | 'canvas-edge'
    /** Generierte Query-View (SPEC §9 / M5). */
    | 'view'
    /** Gespeichertes Retrieval-Profil (SPEC §7.5 / M8). */
    | 'profile'
    /** Selbstmodell (SPEC §18 / M14): die Anwendung und ihre Module. */
    | 'app'
    | 'module'
    /**
     * Struktur und Erfassung externer Messquellen (Kausal-Layer):
     * `place` = Bereich/Etage, `device` = sosa:Platform,
     * `sensor` = sosa:Sensor/Actuator, `observable` = beobachtete Größe,
     * `variable` = die davon erfasste Reihe (ow:Variable).
     */
    | 'place'
    | 'device'
    | 'sensor'
    | 'observable'
    | 'variable';

/**
 * Instanzweite Entitäten (SPEC §17.1 / M13). Nutzer, Gruppen, geteilte
 * Räume und ACL-Regeln gehören keinem Nutzer-Namensraum an — sie sind die
 * Sprache, in der über Nutzer-Namensräume geredet wird. Deshalb liegen
 * ihre IRIs neben `u/<userId>/…`, nicht darin.
 */
export type PrincipalType = 'user' | 'group' | 'space' | 'authorization';

/**
 * Prüft eine Instanz-Base: absolute HTTP(S)-IRI mit abschließendem `/`
 * oder `urn:ow:<uuid>:`. Alles andere ist ein Konfigurationsfehler.
 */
export function isValidInstanceBase(base: string): boolean {
    if (/^urn:ow:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:$/i.test(base)) {
        return true;
    }
    if (!/^https?:\/\//.test(base) || !base.endsWith('/')) return false;
    try {
        new URL(base);
        return true;
    } catch {
        return false;
    }
}

/** Baut die URN-Instanz-Base für die Runtime `local` aus einer UUID. */
export function urnInstanceBase(uuid: string): string {
    return `urn:ow:${uuid.toLowerCase()}:`;
}

/**
 * Stabile ID → IRI-sicheres Segment. IDs sind bereits URL-arm (doc-…,
 * task-…); alles Weitere wird prozentcodiert, damit die IRI wohlgeformt
 * bleibt, ohne die Identität zu verändern.
 */
function encodeSegment(value: string): string {
    return value
        .split('/')
        .map(part => encodeURIComponent(part))
        .join('/');
}

/**
 * Umkehrung von `encodeSegment` für ein einzelnes Segment. Kein
 * `decodeURIComponent` auf dem ganzen Pfad: ein kodierter Schrägstrich
 * darf beim Zurücklesen keine Segmentgrenze erfinden.
 */
function decodeSegment(value: string): string {
    return decodeURIComponent(value);
}

export interface IriFactory {
    readonly instanceBase: string;
    readonly userId: string;
    /** Entitäts-IRI: `<base>u/<userId>/<type>/<stable-id>` (SPEC §3.2). */
    entity(type: EntityType, stableId: string): string;
    /** Nutzerskalierte Graphen: workspace | public | presentation. */
    graph(name: 'workspace' | 'public' | 'presentation'): string;
    /** Import-Graph eines Connectors: `graph/<u>/import/<connectorId>`. */
    importGraph(connectorId: string): string;
    /** Scope-partitionierter Inferenz-Graph (SPEC §7.3). */
    inferredGraph(scope: string): string;
    /** Instanzweite Graphen: meta | acl | shapes | vocab. */
    sharedGraph(name: 'meta' | 'acl' | 'shapes' | 'vocab'): string;
    /** Geteilter Raum (SPEC §17.1). */
    spaceGraph(spaceId: string): string;
    /**
     * Graph EINES ANDEREN Nutzers (SPEC §17.1 / M13). Dieselbe Bildung wie
     * `graph`/`importGraph`/`inferredGraph`, nur mit expliziter Nutzer-ID —
     * nötig, sobald ACL-Regeln über Nutzergrenzen hinweg formuliert werden.
     */
    userGraph(userId: string, scope: string): string;
    /** Instanzweite Entität: Nutzer, Gruppe, Raum, ACL-Regel (SPEC §17.1). */
    principal(type: PrincipalType, id: string): string;
    /** Umkehrung von `principal` — `null`, wenn die IRI nicht passt. */
    principalId(type: PrincipalType, iri: string): string | null;
}

/** Aufschlüsselung eines Named-Graph-IRI (SPEC §3.3) — Basis jeder ACL-Regel. */
export type GraphDescriptor =
    /** `graph/u/<userId>/<scope>` — Nutzergraph (workspace, public, presentation, import/x, inferred/x). */
    | { kind: 'user'; userId: string; scope: string }
    /** `graph/shared/<spaceId>` — geteilter Raum. */
    | { kind: 'space'; spaceId: string }
    /** `graph/meta` | `graph/acl` | `graph/shapes` | `graph/vocab`. */
    | { kind: 'instance'; name: string };

/**
 * Zerlegt einen Graph-IRI dieser Installation. `null` für alles, was nicht
 * unter `<base>graph/` liegt — ein fremder Graph hat in keiner
 * Rechteentscheidung etwas verloren.
 */
export function describeGraph(instanceBase: string, graphIri: string): GraphDescriptor | null {
    const prefix = `${instanceBase}graph/`;
    if (!graphIri.startsWith(prefix)) return null;
    const rest = graphIri.slice(prefix.length);
    if (rest === '') return null;
    const segments = rest.split('/');
    if (segments[0] === 'u') {
        if (segments.length < 3) return null;
        const scope = segments.slice(2).map(decodeSegment).join('/');
        if (scope === '') return null;
        return { kind: 'user', userId: decodeSegment(segments[1]), scope };
    }
    if (segments[0] === 'shared') {
        if (segments.length !== 2 || segments[1] === '') return null;
        return { kind: 'space', spaceId: decodeSegment(segments[1]) };
    }
    if (segments.length !== 1) return null;
    return { kind: 'instance', name: segments[0] };
}

/**
 * Erzeugt die IRI-Fabrik einer Installation. Alle inhaltstragenden Graphen
 * sind nutzerskaliert, auch im Single-User-Betrieb — der Weg zu Multi-User
 * ist damit eine Konfigurationsfrage, keine Datenmigration (SPEC §3.3).
 */
export function createIriFactory(instanceBase: string, userId: string = DEFAULT_USER_ID): IriFactory {
    if (!isValidInstanceBase(instanceBase)) {
        throw new Error(
            `Ungültige Instanz-Base "${instanceBase}": erwartet wird eine absolute ` +
            `HTTP(S)-IRI mit abschließendem "/" oder "urn:ow:<uuid>:".`,
        );
    }
    const u = `u/${encodeSegment(userId)}`;
    return {
        instanceBase,
        userId,
        entity: (type, stableId) => `${instanceBase}${u}/${type}/${encodeSegment(stableId)}`,
        graph: name => `${instanceBase}graph/${u}/${name}`,
        importGraph: connectorId => `${instanceBase}graph/${u}/import/${encodeSegment(connectorId)}`,
        inferredGraph: scope => `${instanceBase}graph/${u}/inferred/${encodeSegment(scope)}`,
        sharedGraph: name => `${instanceBase}graph/${name}`,
        spaceGraph: spaceId => `${instanceBase}graph/shared/${encodeSegment(spaceId)}`,
        userGraph: (otherUserId, scope) =>
            `${instanceBase}graph/u/${encodeSegment(otherUserId)}/${encodeSegment(scope)}`,
        principal: (type, id) => `${instanceBase}${type}/${encodeSegment(id)}`,
        principalId: (type, value) => {
            const prefix = `${instanceBase}${type}/`;
            if (!value.startsWith(prefix)) return null;
            const rest = value.slice(prefix.length);
            return rest === '' || rest.includes('/') ? null : decodeSegment(rest);
        },
    };
}

/**
 * Ein Quad in Minimalform für die Basis-Migration. Bewusst strukturell
 * (nicht @rdfjs/types), damit die Migration auf serialisierten Quads
 * arbeiten kann, bevor ein Store existiert.
 */
export interface IriRewriteResult {
    /** Anzahl umgeschriebener IRIs. */
    rewritten: number;
    /** Brückentripel `neu owl:sameAs alt` als N-Quads-Zeilen für den Workspace-Graphen. */
    bridgeQuads: Array<{ subject: string; predicate: string; object: string }>;
}

/**
 * Migration der Instanz-Base (SPEC §3.2): kein Suchen-und-Ersetzen ohne
 * Spur, sondern Umschreiben plus `owl:sameAs`-Brücke, damit externe
 * Referenzen auf die alten IRIs auflösbar bleiben. Der Aufrufer schreibt
 * die zurückgegebenen Brückentripel in den Workspace-Graphen und
 * protokolliert die Migration als prov:Activity.
 *
 * Arbeitet auf IRI-Strings; die Store-Anbindung (dump → rewrite → load)
 * liegt in server/instance.ts, damit dieses Modul pur bleibt.
 */
export function migrateInstanceIri(iri: string, oldBase: string, newBase: string): string | null {
    if (!iri.startsWith(oldBase)) return null;
    return newBase + iri.slice(oldBase.length);
}

export function buildSameAsBridges(
    movedIris: ReadonlyArray<{ oldIri: string; newIri: string }>,
): IriRewriteResult {
    return {
        rewritten: movedIris.length,
        bridgeQuads: movedIris.map(({ oldIri, newIri }) => ({
            subject: newIri,
            predicate: OWL.sameAs,
            object: oldIri,
        })),
    };
}
