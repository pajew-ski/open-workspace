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
    | 'event'
    | 'conversation'
    | 'message'
    | 'query'
    | 'activity'
    /** Reifier-Knoten einer annotierten Kante (RDF 1.2, rdf:reifies). */
    | 'link';

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
