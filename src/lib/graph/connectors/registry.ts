/**
 * Connector-Registry in `graph/meta` (Invariante 6): Connector-Instanzen
 * und ihre Sync-Zustände sind Knoten im Graphen, keine Einträge in einer
 * parallelen JSON-Datei. Das Selbstmodell (SPEC §18) kann sie damit
 * abfragen wie jeden anderen Inhalt.
 *
 * Modell pro Instanz (SPEC §4.2):
 *   <conn> a ow:Connector, prov:SoftwareAgent ;
 *          schema:name  "…" ;
 *          ow:connectorKind "rdf-file" ;
 *          ow:locator   "…" ;
 *          ow:targetGraph <graph/<u>/import/<id>> ;
 *          ow:syncState "idle" ;
 *          ow:revision  "…" ;              # nach dem ersten Import
 *          dcterms:created/modified "…"^^xsd:dateTime .
 *
 * Der letzte Lauf ist eine prov:Activity (ein Knoten pro Instanz, wird
 * ersetzt, nicht angehäuft) mit schema:description als Zusammenfassung
 * und je einem schema:error-Literal pro quarantänierter Quell-Einheit —
 * das ist der Fehlerbericht, den die UI anzeigt (M3-Abnahme).
 *
 * Alle Schreibzugriffe laufen als dump → modify → replace innerhalb
 * einer Store-Transaktion: kein SPARQL-String-Bau, funktioniert mit
 * Oxigraph und dem Memory-Double gleichermaßen.
 */

import type { NamedNode, Quad } from '@rdfjs/types';
import type { GraphStore } from '../store/types';
import type { IriFactory } from '../iri';
import { factory, namedNode, literal, typedLiteral } from '../rdf';
import { DCTERMS, OW, PROV, RDF, SCHEMA } from '../vocab';
import { pruneOrphanCanvasLayouts } from '../presentation/layout';
import type { ConnectorInstanceView, ConnectorSyncState, QuarantineEntry } from './types';

export interface GraphHandle {
    store: GraphStore;
    iri: IriFactory;
}

/** Höchstzahl gespeicherter Fehlerbericht-Einträge pro Lauf. */
export const MAX_STORED_ERRORS = 50;

const SYNC_STATES: ReadonlySet<string> = new Set(['idle', 'syncing', 'error', 'conflict']);

/** IRI des Lauf-Knotens (prov:Activity) einer Connector-Instanz. */
export function syncRunIri(iri: IriFactory, connectorId: string): string {
    return iri.entity('activity', `sync-${connectorId}`);
}

const runIriFor = syncRunIri;

export function connectorIdFromIri(iri: IriFactory, connectorIri: string): string | null {
    const prefix = `${iri.instanceBase}u/${encodeURIComponent(iri.userId)}/connector/`;
    if (!connectorIri.startsWith(prefix)) return null;
    return decodeURIComponent(connectorIri.slice(prefix.length));
}

async function readMeta(handle: GraphHandle): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const q of handle.store.dump(namedNode(handle.iri.sharedGraph('meta')))) {
        quads.push(q);
    }
    return quads;
}

interface SubjectIndex {
    byPredicate: Map<string, Quad[]>;
}

function indexBySubject(quads: Quad[]): Map<string, SubjectIndex> {
    const index = new Map<string, SubjectIndex>();
    for (const q of quads) {
        if (q.subject.termType !== 'NamedNode') continue;
        let entry = index.get(q.subject.value);
        if (!entry) {
            entry = { byPredicate: new Map() };
            index.set(q.subject.value, entry);
        }
        const list = entry.byPredicate.get(q.predicate.value) ?? [];
        list.push(q);
        entry.byPredicate.set(q.predicate.value, list);
    }
    return index;
}

function firstValue(entry: SubjectIndex | undefined, predicate: string): string | undefined {
    return entry?.byPredicate.get(predicate)?.[0]?.object.value;
}

function hasType(entry: SubjectIndex | undefined, type: string): boolean {
    return (entry?.byPredicate.get(RDF.type) ?? []).some(q => q.object.value === type);
}

function viewFromIndex(
    handle: GraphHandle,
    connectorIri: string,
    index: Map<string, SubjectIndex>,
): ConnectorInstanceView | null {
    const entry = index.get(connectorIri);
    if (!hasType(entry, OW.Connector)) return null;
    const id = connectorIdFromIri(handle.iri, connectorIri);
    if (!id) return null;

    const stateRaw = firstValue(entry, OW.syncState);
    const runEntry = index.get(runIriFor(handle.iri, id));
    const runAt = firstValue(runEntry, PROV.generatedAtTime);

    return {
        id,
        iri: connectorIri,
        name: firstValue(entry, SCHEMA.name) ?? id,
        kind: firstValue(entry, OW.connectorKind) ?? 'unbekannt',
        locator: firstValue(entry, OW.locator) ?? '',
        targetGraph: firstValue(entry, OW.targetGraph) ?? handle.iri.importGraph(id),
        syncState: (SYNC_STATES.has(stateRaw ?? '') ? stateRaw : 'idle') as ConnectorSyncState,
        revision: firstValue(entry, OW.revision),
        createdAt: firstValue(entry, DCTERMS.created),
        modifiedAt: firstValue(entry, DCTERMS.modified),
        lastRun: runEntry
            ? {
                at: runAt,
                revision: firstValue(runEntry, OW.revision),
                summary: firstValue(runEntry, SCHEMA.description),
                errors: (runEntry.byPredicate.get(SCHEMA.error) ?? []).map(q => q.object.value).sort(),
            }
            : undefined,
    };
}

export async function listConnectors(handle: GraphHandle): Promise<ConnectorInstanceView[]> {
    const index = indexBySubject(await readMeta(handle));
    const views: ConnectorInstanceView[] = [];
    for (const subject of index.keys()) {
        const view = viewFromIndex(handle, subject, index);
        if (view) views.push(view);
    }
    return views.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

export async function getConnector(handle: GraphHandle, id: string): Promise<ConnectorInstanceView | null> {
    const index = indexBySubject(await readMeta(handle));
    return viewFromIndex(handle, handle.iri.entity('connector', id), index);
}

function connectorNodeQuads(handle: GraphHandle, view: ConnectorInstanceView, graph: NamedNode): Quad[] {
    const conn = namedNode(view.iri);
    const quads: Quad[] = [
        factory.quad(conn, namedNode(RDF.type), namedNode(OW.Connector), graph),
        factory.quad(conn, namedNode(RDF.type), namedNode(PROV.SoftwareAgent), graph),
        factory.quad(conn, namedNode(SCHEMA.name), literal(view.name), graph),
        factory.quad(conn, namedNode(OW.connectorKind), literal(view.kind), graph),
        factory.quad(conn, namedNode(OW.locator), literal(view.locator), graph),
        factory.quad(conn, namedNode(OW.targetGraph), namedNode(view.targetGraph), graph),
        factory.quad(conn, namedNode(OW.syncState), literal(view.syncState), graph),
    ];
    if (view.revision) {
        quads.push(factory.quad(conn, namedNode(OW.revision), literal(view.revision), graph));
    }
    if (view.createdAt) {
        quads.push(factory.quad(conn, namedNode(DCTERMS.created), typedLiteral.dateTime(view.createdAt), graph));
    }
    if (view.modifiedAt) {
        quads.push(factory.quad(conn, namedNode(DCTERMS.modified), typedLiteral.dateTime(view.modifiedAt), graph));
    }
    if (view.lastRun) {
        const run = namedNode(runIriFor(handle.iri, view.id));
        quads.push(
            factory.quad(run, namedNode(RDF.type), namedNode(PROV.Activity), graph),
            factory.quad(run, namedNode(PROV.wasAttributedTo), conn, graph),
        );
        if (view.lastRun.at) {
            quads.push(factory.quad(run, namedNode(PROV.generatedAtTime), typedLiteral.dateTime(view.lastRun.at), graph));
        }
        if (view.lastRun.revision) {
            quads.push(factory.quad(run, namedNode(OW.revision), literal(view.lastRun.revision), graph));
        }
        if (view.lastRun.summary) {
            quads.push(factory.quad(run, namedNode(SCHEMA.description), literal(view.lastRun.summary, 'de'), graph));
        }
        for (const message of view.lastRun.errors) {
            quads.push(factory.quad(run, namedNode(SCHEMA.error), literal(message), graph));
        }
    }
    return quads;
}

/**
 * Ersetzt die Knoten einer Connector-Instanz (Connector + letzter Lauf)
 * in `graph/meta`, ohne andere Meta-Inhalte anzufassen. Läuft auf dem
 * übergebenen Store — innerhalb einer Transaktion ist das die tx-Sicht.
 */
async function replaceConnectorNodes(
    handle: GraphHandle,
    connectorId: string,
    build: ((graph: NamedNode) => Quad[]) | null,
): Promise<void> {
    const metaGraph = namedNode(handle.iri.sharedGraph('meta'));
    const connIri = handle.iri.entity('connector', connectorId);
    const runIri = runIriFor(handle.iri, connectorId);
    const remaining = (await readMeta(handle)).filter(q =>
        !(q.subject.termType === 'NamedNode' && (q.subject.value === connIri || q.subject.value === runIri)),
    );
    const next = build ? [...remaining, ...build(metaGraph)] : remaining;
    await handle.store.load(next, metaGraph, { replace: true });
}

function randomSuffix(): string {
    const bytes = new Uint8Array(4);
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export interface CreateConnectorInput {
    name: string;
    kind: string;
    locator: string;
    /** Nur für Tests: deterministische ID statt Zufallssuffix. */
    id?: string;
}

export async function createConnector(handle: GraphHandle, input: CreateConnectorInput): Promise<ConnectorInstanceView> {
    const id = input.id ?? `${input.kind}-${randomSuffix()}`;
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
        throw new Error(`Ungültige Connector-ID "${id}" (erlaubt: Buchstaben, Ziffern, Bindestriche).`);
    }
    if (await getConnector(handle, id)) {
        throw new Error(`Connector-ID "${id}" existiert bereits.`);
    }
    const now = new Date().toISOString();
    const view: ConnectorInstanceView = {
        id,
        iri: handle.iri.entity('connector', id),
        name: input.name,
        kind: input.kind,
        locator: input.locator,
        targetGraph: handle.iri.importGraph(id),
        syncState: 'idle',
        createdAt: now,
        modifiedAt: now,
    };
    await handle.store.transaction(async tx => {
        await replaceConnectorNodes({ store: tx, iri: handle.iri }, id, graph => connectorNodeQuads(handle, view, graph));
    });
    return view;
}

/** Persistiert den Zustand nach einem Sync-Lauf (vom Runner aufgerufen). */
export async function saveConnectorState(handle: GraphHandle, view: ConnectorInstanceView): Promise<void> {
    await replaceConnectorNodes(handle, view.id, graph => connectorNodeQuads(handle, view, graph));
}

/**
 * Entfernt Instanz-Knoten, letzten Lauf UND den Import-Graphen. Der
 * Import-Graph gehört dem Connector (SPEC §6.2) — ohne Connector bliebe
 * er als herrenloser Spiegel zurück. Layout-Gruppen in
 * graph/<u>/presentation, deren Canvas mit dem Import verschwindet,
 * werden in derselben Transaktion mit ausgeräumt (SPEC §9, M5).
 */
export async function deleteConnector(handle: GraphHandle, id: string): Promise<boolean> {
    const existing = await getConnector(handle, id);
    if (!existing) return false;
    await handle.store.transaction(async tx => {
        const txHandle = { store: tx, iri: handle.iri };
        await replaceConnectorNodes(txHandle, id, null);
        await tx.load([], namedNode(existing.targetGraph), { replace: true });
        await pruneOrphanCanvasLayouts(tx, handle.iri);
    });
    return true;
}

/** Baut den Fehlerbericht-Anteil eines Laufs (gekappt, deterministisch). */
export function runErrors(quarantined: QuarantineEntry[]): string[] {
    const messages = quarantined.map(entry => `${entry.source}: ${entry.reason}`);
    if (messages.length <= MAX_STORED_ERRORS) return messages;
    const kept = messages.slice(0, MAX_STORED_ERRORS);
    kept.push(`… und ${messages.length - MAX_STORED_ERRORS} weitere Einträge (gekürzt).`);
    return kept;
}
