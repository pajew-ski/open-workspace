/**
 * Registry föderierter SPARQL-Endpoints (SPEC §7.4, M11).
 *
 * „Endpoint-Registry in `graph/meta` als `ow:FederatedEndpoint`-Knoten mit
 * `ow:trustLevel`." — also dasselbe Muster wie Connector-Instanzen (M3),
 * Query-Views (M5) und Retrieval-Profile (M8): die Registry IST Graph,
 * keine parallele JSON-Datei (Invariante 6).
 *
 * Modell pro Endpoint:
 *   <ep> a ow:FederatedEndpoint, schema:Service ;
 *        schema:name        "Wikidata" ;
 *        ow:sparqlEndpoint  "https://query.wikidata.org/sparql"^^xsd:anyURI ;
 *        ow:trustLevel      "known" ;
 *        schema:description "…" ;
 *        dcterms:created/modified "…"^^xsd:dateTime .
 *
 * Die Vertrauensstufe ist kein Schmuck, sondern steuert das Verhalten
 * ausgehender `SERVICE`-Aufrufe (siehe `service.ts`):
 *
 *   unknown  — registriert, aber gesperrt. Default beim Anlegen; ein
 *              Endpoint wird erst nach bewusster Hochstufung benutzbar.
 *   known    — `SERVICE` erlaubt, aber es verlässt **keine lokale
 *              Bindung** die Installation: das entfernte Muster wird
 *              eigenständig ausgewertet und lokal gejoint.
 *   trusted  — zusätzlich Bound-Join: lokale Join-Schlüssel dürfen als
 *              `VALUES` mitgeschickt werden (schnell, aber die Werte
 *              sind dann beim Betreiber des Endpoints sichtbar).
 */

import type { Quad } from '@rdfjs/types';
import type { GraphStore } from '../store/types';
import type { IriFactory } from '../iri';
import { factory, literal, namedNode, typedLiteral } from '../rdf';
import { DCTERMS, OW, RDF, SCHEMA } from '../vocab';
import { isPrivateHostname } from '@/lib/net/private';

export interface GraphHandle {
    store: GraphStore;
    iri: IriFactory;
}

export const TRUST_LEVELS = ['unknown', 'known', 'trusted'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export function isTrustLevel(value: string): value is TrustLevel {
    return (TRUST_LEVELS as readonly string[]).includes(value);
}

/** Menschenlesbare Bedeutung der Stufen — eine Quelle für UI und Fehler. */
export const TRUST_LEVEL_LABELS: Record<TrustLevel, string> = {
    unknown: 'unbekannt — für SERVICE gesperrt',
    known: 'bekannt — SERVICE erlaubt, keine lokalen Bindungen werden gesendet',
    trusted: 'vertraut — SERVICE erlaubt, Bound-Join mit lokalen Werten',
};

export interface FederatedEndpointRecord {
    id: string;
    iri: string;
    name: string;
    /** Query-URL des Endpoints (http/https). */
    url: string;
    trustLevel: TrustLevel;
    description?: string;
    createdAt?: string;
    modifiedAt?: string;
}

function endpointIriFor(iri: IriFactory, id: string): string {
    return iri.entity('endpoint', id);
}

function endpointIdFromIri(iri: IriFactory, endpointIri: string): string | null {
    const prefix = endpointIriFor(iri, '');
    if (!endpointIri.startsWith(prefix)) return null;
    return decodeURIComponent(endpointIri.slice(prefix.length));
}

/**
 * Politik für Endpoint-URLs — dieselbe wie für Connector-Pulls
 * (`connectors/http.ts`): nur http(s), keine privaten/lokalen Ziele ohne
 * `ALLOW_LOCAL_TOOL_URLS=1`. Der Schutz greift schon beim Registrieren,
 * nicht erst beim Aufruf: ein Endpoint, der nie erlaubt sein kann, hat in
 * der Registry nichts verloren.
 */
export function assertFederationUrl(raw: string): URL {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error(`Ungültige Endpoint-URL: "${raw}".`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`Nur http(s)-Endpoints sind erlaubt, nicht "${url.protocol}".`);
    }
    if (process.env.ALLOW_LOCAL_TOOL_URLS !== '1' && isPrivateHostname(url.hostname)) {
        throw new Error(
            `Endpoint "${url.hostname}" liegt in einem privaten/lokalen Adressbereich und ist blockiert. ` +
            'Setze ALLOW_LOCAL_TOOL_URLS=1, wenn lokale Endpoints erlaubt sein sollen.',
        );
    }
    return url;
}

async function readMeta(handle: GraphHandle): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const q of handle.store.dump(namedNode(handle.iri.sharedGraph('meta')))) {
        quads.push(q);
    }
    return quads;
}

function recordFromQuads(handle: GraphHandle, endpointIri: string, quads: Quad[]): FederatedEndpointRecord | null {
    const mine = quads.filter(q => q.subject.termType === 'NamedNode' && q.subject.value === endpointIri);
    if (!mine.some(q => q.predicate.value === RDF.type && q.object.value === OW.FederatedEndpoint)) return null;
    const id = endpointIdFromIri(handle.iri, endpointIri);
    if (!id) return null;
    const value = (predicate: string) => mine.find(q => q.predicate.value === predicate)?.object.value;
    const url = value(OW.sparqlEndpoint);
    if (!url) return null;
    const rawTrust = value(OW.trustLevel) ?? 'unknown';
    const description = value(SCHEMA.description);
    return {
        id,
        iri: endpointIri,
        name: value(SCHEMA.name) ?? id,
        url,
        // Ein unbekannter Wert wird zur strengsten Stufe, nie zur mildesten.
        trustLevel: isTrustLevel(rawTrust) ? rawTrust : 'unknown',
        ...(description ? { description } : {}),
        createdAt: value(DCTERMS.created),
        modifiedAt: value(DCTERMS.modified),
    };
}

export async function listFederatedEndpoints(handle: GraphHandle): Promise<FederatedEndpointRecord[]> {
    const quads = await readMeta(handle);
    const subjects = new Set<string>();
    for (const q of quads) {
        if (q.predicate.value === RDF.type && q.object.value === OW.FederatedEndpoint && q.subject.termType === 'NamedNode') {
            subjects.add(q.subject.value);
        }
    }
    const records: FederatedEndpointRecord[] = [];
    for (const subject of subjects) {
        const record = recordFromQuads(handle, subject, quads);
        if (record) records.push(record);
    }
    return records.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

export async function getFederatedEndpoint(handle: GraphHandle, id: string): Promise<FederatedEndpointRecord | null> {
    return recordFromQuads(handle, endpointIriFor(handle.iri, id), await readMeta(handle));
}

function endpointQuads(record: FederatedEndpointRecord, graph: Quad['graph']): Quad[] {
    const subject = namedNode(record.iri);
    const quads: Quad[] = [
        factory.quad(subject, namedNode(RDF.type), namedNode(OW.FederatedEndpoint), graph),
        factory.quad(subject, namedNode(RDF.type), namedNode(SCHEMA.Service), graph),
        factory.quad(subject, namedNode(SCHEMA.name), literal(record.name), graph),
        factory.quad(subject, namedNode(OW.sparqlEndpoint), typedLiteral.anyUri(record.url), graph),
        factory.quad(subject, namedNode(OW.trustLevel), literal(record.trustLevel), graph),
    ];
    if (record.description) {
        quads.push(factory.quad(subject, namedNode(SCHEMA.description), literal(record.description), graph));
    }
    if (record.createdAt) {
        quads.push(factory.quad(subject, namedNode(DCTERMS.created), typedLiteral.dateTime(record.createdAt), graph));
    }
    if (record.modifiedAt) {
        quads.push(factory.quad(subject, namedNode(DCTERMS.modified), typedLiteral.dateTime(record.modifiedAt), graph));
    }
    return quads;
}

async function replaceEndpointNode(
    handle: GraphHandle,
    id: string,
    build: FederatedEndpointRecord | null,
): Promise<void> {
    const metaGraph = namedNode(handle.iri.sharedGraph('meta'));
    const endpointIri = endpointIriFor(handle.iri, id);
    const remaining = (await readMeta(handle)).filter(
        q => !(q.subject.termType === 'NamedNode' && q.subject.value === endpointIri),
    );
    const next = build ? [...remaining, ...endpointQuads(build, metaGraph)] : remaining;
    await handle.store.load(next, metaGraph, { replace: true });
}

export interface CreateFederatedEndpointInput {
    id: string;
    name: string;
    url: string;
    /** Default `unknown`: ein neuer Endpoint ist zuerst gesperrt. */
    trustLevel?: TrustLevel;
    description?: string;
    /** Zeitpunkt (Tests: fest). */
    now?: Date;
}

export async function createFederatedEndpoint(
    handle: GraphHandle,
    input: CreateFederatedEndpointInput,
): Promise<FederatedEndpointRecord> {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(input.id)) {
        throw new Error(`Ungültige Endpoint-ID "${input.id}" (erlaubt: Buchstaben, Ziffern, Bindestriche).`);
    }
    if (await getFederatedEndpoint(handle, input.id)) {
        throw new Error(`Endpoint-ID "${input.id}" existiert bereits.`);
    }
    const url = assertFederationUrl(input.url);
    const now = (input.now ?? new Date()).toISOString();
    const record: FederatedEndpointRecord = {
        id: input.id,
        iri: endpointIriFor(handle.iri, input.id),
        name: input.name,
        url: url.toString(),
        trustLevel: input.trustLevel ?? 'unknown',
        ...(input.description ? { description: input.description } : {}),
        createdAt: now,
        modifiedAt: now,
    };
    await handle.store.transaction(async tx => {
        await replaceEndpointNode({ store: tx, iri: handle.iri }, record.id, record);
    });
    return record;
}

export interface UpdateFederatedEndpointInput {
    name?: string;
    url?: string;
    trustLevel?: TrustLevel;
    description?: string | null;
    now?: Date;
}

export async function updateFederatedEndpoint(
    handle: GraphHandle,
    id: string,
    input: UpdateFederatedEndpointInput,
): Promise<FederatedEndpointRecord | null> {
    const existing = await getFederatedEndpoint(handle, id);
    if (!existing) return null;
    const url = input.url !== undefined ? assertFederationUrl(input.url).toString() : existing.url;
    const description = input.description === null
        ? undefined
        : input.description ?? existing.description;
    const next: FederatedEndpointRecord = {
        ...existing,
        name: input.name ?? existing.name,
        url,
        trustLevel: input.trustLevel ?? existing.trustLevel,
        ...(description ? { description } : {}),
        modifiedAt: (input.now ?? new Date()).toISOString(),
    };
    if (description === undefined) delete next.description;
    await handle.store.transaction(async tx => {
        await replaceEndpointNode({ store: tx, iri: handle.iri }, id, next);
    });
    return next;
}

export async function deleteFederatedEndpoint(handle: GraphHandle, id: string): Promise<boolean> {
    if (!(await getFederatedEndpoint(handle, id))) return false;
    await handle.store.transaction(async tx => {
        await replaceEndpointNode({ store: tx, iri: handle.iri }, id, null);
    });
    return true;
}
