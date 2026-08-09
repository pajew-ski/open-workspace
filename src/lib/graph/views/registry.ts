/**
 * Generierte Query-Views (SPEC §9, M5): gespeicherte SPARQL-Queries als
 * ow:QueryView-Knoten in `graph/meta` — Live-Subgraphen ohne persistiertes
 * Layout, nur mit einem Layout-VERFAHREN (force-directed, hierarchisch,
 * radial). Das unterscheidet sie von ow:Canvas (manuell kuratiert,
 * Anordnung in graph/presentation).
 *
 * `graph/meta` statt workspace, weil der Workspace-Graph im
 * Übergangszustand (// MIGRATION, SPEC §12.4) bei jedem Datei-Sync
 * vollständig ersetzt wird — Views sind Systemkonfiguration wie die
 * Connector-Registry und überleben dort Neustarts (meta.nq-Snapshot).
 *
 * Aufgelöst wird eine View über dasselbe erlaubte Dataset wie jede
 * SPARQL-Anfrage (resolveDataset, Vorstufe von SPEC §17.3): presentation,
 * inferred und acl sind draußen, injiziert statt nachgefiltert.
 */

import type { Quad, Term } from '@rdfjs/types';
import type { GraphStore } from '../store/types';
import type { IriFactory } from '../iri';
import { factory, namedNode, literal, typedLiteral } from '../rdf';
import { DCTERMS, OW, RDF, SCHEMA, SKOS, PREFIXES } from '../vocab';
import { resolveDataset } from '../sparql/protocol';

export interface GraphHandle {
    store: GraphStore;
    iri: IriFactory;
}

export const LAYOUT_METHODS = ['force-directed', 'hierarchical', 'radial'] as const;
export type LayoutMethod = (typeof LAYOUT_METHODS)[number];

export interface QueryViewRecord {
    id: string;
    iri: string;
    name: string;
    queryText: string;
    layoutMethod: LayoutMethod;
    createdAt?: string;
    modifiedAt?: string;
}

/** Harte Kappung der Auflösung — Query-seitige Begrenzung statt UI-Kollaps (SPEC §11). */
export const MAX_VIEW_QUADS = 5_000;

function viewIriFor(iri: IriFactory, id: string): string {
    return iri.entity('view', id);
}

function viewIdFromIri(iri: IriFactory, viewIri: string): string | null {
    const prefix = `${iri.instanceBase}u/${encodeURIComponent(iri.userId)}/view/`;
    if (!viewIri.startsWith(prefix)) return null;
    return decodeURIComponent(viewIri.slice(prefix.length));
}

async function readMeta(handle: GraphHandle): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const q of handle.store.dump(namedNode(handle.iri.sharedGraph('meta')))) {
        quads.push(q);
    }
    return quads;
}

function recordFromQuads(handle: GraphHandle, viewIri: string, quads: Quad[]): QueryViewRecord | null {
    const mine = quads.filter(q => q.subject.termType === 'NamedNode' && q.subject.value === viewIri);
    if (!mine.some(q => q.predicate.value === RDF.type && q.object.value === OW.QueryView)) return null;
    const id = viewIdFromIri(handle.iri, viewIri);
    if (!id) return null;
    const value = (predicate: string) => mine.find(q => q.predicate.value === predicate)?.object.value;
    const layoutRaw = value(OW.layoutMethod);
    return {
        id,
        iri: viewIri,
        name: value(SCHEMA.name) ?? id,
        queryText: value(OW.queryText) ?? '',
        layoutMethod: (LAYOUT_METHODS as readonly string[]).includes(layoutRaw ?? '')
            ? (layoutRaw as LayoutMethod)
            : 'force-directed',
        createdAt: value(DCTERMS.created),
        modifiedAt: value(DCTERMS.modified),
    };
}

export async function listQueryViews(handle: GraphHandle): Promise<QueryViewRecord[]> {
    const quads = await readMeta(handle);
    const subjects = new Set<string>();
    for (const q of quads) {
        if (q.predicate.value === RDF.type && q.object.value === OW.QueryView && q.subject.termType === 'NamedNode') {
            subjects.add(q.subject.value);
        }
    }
    const records: QueryViewRecord[] = [];
    for (const subject of subjects) {
        const record = recordFromQuads(handle, subject, quads);
        if (record) records.push(record);
    }
    return records.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

export async function getQueryView(handle: GraphHandle, id: string): Promise<QueryViewRecord | null> {
    return recordFromQuads(handle, viewIriFor(handle.iri, id), await readMeta(handle));
}

function viewQuads(record: QueryViewRecord, graph: Quad['graph']): Quad[] {
    const subject = namedNode(record.iri);
    const quads: Quad[] = [
        factory.quad(subject, namedNode(RDF.type), namedNode(OW.QueryView), graph),
        factory.quad(subject, namedNode(SCHEMA.name), literal(record.name), graph),
        factory.quad(subject, namedNode(OW.queryText), literal(record.queryText), graph),
        factory.quad(subject, namedNode(OW.layoutMethod), literal(record.layoutMethod), graph),
    ];
    if (record.createdAt) {
        quads.push(factory.quad(subject, namedNode(DCTERMS.created), typedLiteral.dateTime(record.createdAt), graph));
    }
    if (record.modifiedAt) {
        quads.push(factory.quad(subject, namedNode(DCTERMS.modified), typedLiteral.dateTime(record.modifiedAt), graph));
    }
    return quads;
}

async function replaceViewNodes(handle: GraphHandle, id: string, build: QueryViewRecord | null): Promise<void> {
    const metaGraph = namedNode(handle.iri.sharedGraph('meta'));
    const viewIri = viewIriFor(handle.iri, id);
    const remaining = (await readMeta(handle)).filter(
        q => !(q.subject.termType === 'NamedNode' && q.subject.value === viewIri),
    );
    const next = build ? [...remaining, ...viewQuads(build, metaGraph)] : remaining;
    await handle.store.load(next, metaGraph, { replace: true });
}

function randomSuffix(): string {
    const bytes = new Uint8Array(4);
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export interface CreateQueryViewInput {
    name: string;
    queryText: string;
    layoutMethod: LayoutMethod;
    /** Nur für Tests: deterministische ID statt Zufallssuffix. */
    id?: string;
}

export async function createQueryView(handle: GraphHandle, input: CreateQueryViewInput): Promise<QueryViewRecord> {
    const id = input.id ?? `view-${randomSuffix()}`;
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
        throw new Error(`Ungültige View-ID "${id}" (erlaubt: Buchstaben, Ziffern, Bindestriche).`);
    }
    if (await getQueryView(handle, id)) {
        throw new Error(`View-ID "${id}" existiert bereits.`);
    }
    const now = new Date().toISOString();
    const record: QueryViewRecord = {
        id,
        iri: viewIriFor(handle.iri, id),
        name: input.name,
        queryText: input.queryText,
        layoutMethod: input.layoutMethod,
        createdAt: now,
        modifiedAt: now,
    };
    await handle.store.transaction(async tx => {
        await replaceViewNodes({ store: tx, iri: handle.iri }, id, record);
    });
    return record;
}

export async function deleteQueryView(handle: GraphHandle, id: string): Promise<boolean> {
    if (!(await getQueryView(handle, id))) return false;
    await handle.store.transaction(async tx => {
        await replaceViewNodes({ store: tx, iri: handle.iri }, id, null);
    });
    return true;
}

// --- Auflösung -----------------------------------------------------------

export interface ResolvedViewNode {
    id: string;
    name: string;
    type: string;
}

export interface ResolvedViewLink {
    source: string;
    target: string;
    type: string;
}

export interface ResolvedQueryView {
    view: QueryViewRecord;
    nodes: ResolvedViewNode[];
    links: ResolvedViewLink[];
    quadCount: number;
    truncated: boolean;
}

function localName(iriValue: string): string {
    const hash = iriValue.lastIndexOf('#');
    const slash = iriValue.lastIndexOf('/');
    const cut = Math.max(hash, slash);
    const local = cut === -1 ? iriValue : iriValue.slice(cut + 1);
    return local === '' ? iriValue : decodeURIComponent(local);
}

const LABEL_PREDICATES = [
    SCHEMA.name,
    SKOS.prefLabel,
    `${PREFIXES.rdfs}label`,
    `${PREFIXES.dcterms}title`,
];

/** Graph-Auflösung eines Query-Texts ohne gespeicherte View (Editor-Vorschau). */
export interface ResolvedQueryGraph {
    nodes: ResolvedViewNode[];
    links: ResolvedViewLink[];
    quadCount: number;
    truncated: boolean;
}

/**
 * Führt einen Query-Text gegen das erlaubte Dataset aus und baut den
 * Subgraphen für den Explorer. Nur graph-förmige Ergebnisse
 * (CONSTRUCT/DESCRIBE) sind eine View — SELECT/ASK werden mit klarer
 * Meldung abgelehnt, Updates lehnt der Store selbst ab. Grundlage sowohl
 * der gespeicherten Views (resolveQueryView) als auch der
 * Ergebnis-als-Graph-Ansicht des SPARQL-Editors (M2).
 */
export async function resolveQueryTextAsGraph(handle: GraphHandle, queryText: string): Promise<ResolvedQueryGraph> {
    const dataset = await resolveDataset(handle.store, handle.iri);
    const result = await handle.store.query(queryText, {
        defaultGraphs: dataset.defaultGraphs,
        namedGraphs: dataset.namedGraphs,
        timeoutMs: 30_000,
    });
    if (result.type !== 'quads') {
        throw new Error('Eine Query-View braucht ein Graph-Ergebnis — benutze CONSTRUCT oder DESCRIBE.');
    }

    const quads: Quad[] = [];
    let truncated = false;
    for await (const q of result.quads) {
        if (quads.length >= MAX_VIEW_QUADS) {
            truncated = true;
            break;
        }
        quads.push(q);
    }

    const labels = new Map<string, string>();
    const types = new Map<string, string>();
    const nodeIds = new Set<string>();
    const links: ResolvedViewLink[] = [];
    const seenLinks = new Set<string>();

    const noteNode = (term: Term) => {
        if (term.termType === 'NamedNode') nodeIds.add(term.value);
    };

    for (const q of quads) {
        if (q.subject.termType !== 'NamedNode') continue;
        const subject = q.subject.value;
        if (q.predicate.value === RDF.type && q.object.termType === 'NamedNode') {
            noteNode(q.subject);
            if (!types.has(subject)) types.set(subject, localName(q.object.value));
            continue;
        }
        if (q.object.termType === 'Literal') {
            if (LABEL_PREDICATES.includes(q.predicate.value) && !labels.has(subject)) {
                noteNode(q.subject);
                labels.set(subject, q.object.value);
            }
            continue;
        }
        if (q.object.termType === 'NamedNode') {
            noteNode(q.subject);
            noteNode(q.object);
            const key = `${subject}\t${q.predicate.value}\t${q.object.value}`;
            if (!seenLinks.has(key)) {
                seenLinks.add(key);
                links.push({ source: subject, target: q.object.value, type: localName(q.predicate.value) });
            }
        }
    }

    const nodes: ResolvedViewNode[] = [...nodeIds].sort().map(nodeId => ({
        id: nodeId,
        name: labels.get(nodeId) ?? localName(nodeId),
        type: types.get(nodeId) ?? 'Ressource',
    }));

    return { nodes, links, quadCount: quads.length, truncated };
}

/** Löst eine gespeicherte View über ihren Query-Text auf. */
export async function resolveQueryView(handle: GraphHandle, id: string): Promise<ResolvedQueryView> {
    const view = await getQueryView(handle, id);
    if (!view) {
        throw new Error(`View "${id}" ist nicht registriert.`);
    }
    const resolved = await resolveQueryTextAsGraph(handle, view.queryText);
    return { view, ...resolved };
}
