/**
 * Retrieval-Profile (SPEC §7.5, M8): gespeicherte Parametersätze der
 * Retrieval-Pipeline als `ow:RetrievalProfile`-Knoten in `graph/meta` —
 * Graph-Entitäten, damit selbst abfragbar (und ab M10 als MCP-Prompts
 * exponierbar). Muster wie die Query-Views (M5): `graph/meta`, weil
 * Profile Systemkonfiguration sind und den Workspace-Replace überleben.
 *
 * Die Parameter liegen als JSON-Literal in `ow:retrievalConfig`
 * (Präzedenz: ow:inputSchema) — die verbindliche Form ist die
 * TypeScript-Schnittstelle aus §7.5, eine tripelweise Abbildung wäre
 * verlustbehaftet.
 */

import type { Quad } from '@rdfjs/types';
import type { GraphStore } from '../store/types';
import type { IriFactory } from '../iri';
import { factory, literal, namedNode, typedLiteral } from '../rdf';
import { DCTERMS, OW, RDF, SCHEMA } from '../vocab';
import { withRetrievalDefaults, type RetrievalCausal, type RetrievalRequestInput } from './retrieval';
import { CAUSAL_MODES } from '../causal/trace';
import { EVIDENCE_LEVELS } from '../causal/types';

export interface GraphHandle {
    store: GraphStore;
    iri: IriFactory;
}

export interface RetrievalProfileRecord {
    id: string;
    iri: string;
    name: string;
    description?: string;
    /** Parametersatz (partiell — Defaults füllt withRetrievalDefaults). */
    config: RetrievalRequestInput;
    createdAt?: string;
    modifiedAt?: string;
}

function profileIriFor(iri: IriFactory, id: string): string {
    return iri.entity('profile', id);
}

function profileIdFromIri(iri: IriFactory, profileIri: string): string | null {
    const prefix = profileIriFor(iri, '');
    if (!profileIri.startsWith(prefix)) return null;
    return decodeURIComponent(profileIri.slice(prefix.length));
}

async function readMeta(handle: GraphHandle): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const q of handle.store.dump(namedNode(handle.iri.sharedGraph('meta')))) {
        quads.push(q);
    }
    return quads;
}

/** Nur bekannte RetrievalRequest-Felder aus dem JSON-Literal übernehmen. */
function sanitizeConfig(raw: unknown): RetrievalRequestInput {
    if (typeof raw !== 'object' || raw === null) return {};
    const source = raw as Record<string, unknown>;
    const out: RetrievalRequestInput = {};
    if (typeof source.maxHops === 'number') out.maxHops = source.maxHops;
    if (typeof source.maxNodes === 'number') out.maxNodes = source.maxNodes;
    if (typeof source.decay === 'number') out.decay = source.decay;
    if (typeof source.maxDegree === 'number') out.maxDegree = source.maxDegree;
    if (typeof source.tokenBudget === 'number') out.tokenBudget = source.tokenBudget;
    if (typeof source.seedLimit === 'number') out.seedLimit = source.seedLimit;
    if (typeof source.includeInferred === 'boolean') out.includeInferred = source.includeInferred;
    if (source.direction === 'out' || source.direction === 'in' || source.direction === 'both') {
        out.direction = source.direction;
    }
    if (source.format === 'subgraph' || source.format === 'context' || source.format === 'both') {
        out.format = source.format;
    }
    const stringArray = (value: unknown): string[] | undefined =>
        Array.isArray(value) && value.every(v => typeof v === 'string') ? value as string[] : undefined;
    const typeFilter = (value: unknown): { include?: string[]; exclude?: string[] } | undefined => {
        if (typeof value !== 'object' || value === null) return undefined;
        const raw = value as Record<string, unknown>;
        const include = stringArray(raw.include);
        const exclude = stringArray(raw.exclude);
        if (!include && !exclude) return undefined;
        return { ...(include ? { include } : {}), ...(exclude ? { exclude } : {}) };
    };
    const edgeTypes = typeFilter(source.edgeTypes);
    if (edgeTypes) out.edgeTypes = edgeTypes;
    const nodeTypes = typeFilter(source.nodeTypes);
    if (nodeTypes) out.nodeTypes = nodeTypes;
    const graphs = stringArray(source.graphs);
    if (graphs) out.graphs = graphs;
    const causal = sanitizeCausal(source.causal);
    if (causal) out.causal = causal;
    return out;
}

/**
 * Kausale Erdung im Profil (§9, C2): ein gespeichertes Profil darf eine
 * kausale Frage tragen („Wirkung der Nachtabsenkung auf den Verbrauch,
 * adjustiert für die Außentemperatur"). Übernommen wird nur, was der
 * Vertrag kennt — ein unbekannter Modus fiele sonst erst beim Ausführen
 * auf, und ein Profil ohne Modus wäre keine kausale Anfrage.
 */
function sanitizeCausal(raw: unknown): RetrievalCausal | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const source = raw as Record<string, unknown>;
    const mode = CAUSAL_MODES.find(known => known === source.mode);
    if (!mode) return undefined;
    const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
    const blockedBy = Array.isArray(source.blockedBy) && source.blockedBy.every(v => typeof v === 'string')
        ? source.blockedBy as string[]
        : undefined;
    const minEvidence = EVIDENCE_LEVELS.find(known => known === source.minEvidence);
    const treatment = text(source.treatment);
    const outcome = text(source.outcome);
    const model = text(source.model);
    return {
        mode,
        ...(treatment ? { treatment } : {}),
        ...(outcome ? { outcome } : {}),
        ...(model ? { model } : {}),
        ...(blockedBy ? { blockedBy } : {}),
        ...(minEvidence ? { minEvidence } : {}),
    };
}

function recordFromQuads(handle: GraphHandle, profileIri: string, quads: Quad[]): RetrievalProfileRecord | null {
    const mine = quads.filter(q => q.subject.termType === 'NamedNode' && q.subject.value === profileIri);
    if (!mine.some(q => q.predicate.value === RDF.type && q.object.value === OW.RetrievalProfile)) return null;
    const id = profileIdFromIri(handle.iri, profileIri);
    if (!id) return null;
    const value = (predicate: string) => mine.find(q => q.predicate.value === predicate)?.object.value;
    let config: RetrievalRequestInput = {};
    const rawConfig = value(OW.retrievalConfig);
    if (rawConfig) {
        try {
            config = sanitizeConfig(JSON.parse(rawConfig));
        } catch {
            config = {};
        }
    }
    const description = value(SCHEMA.description);
    return {
        id,
        iri: profileIri,
        name: value(SCHEMA.name) ?? id,
        ...(description ? { description } : {}),
        config,
        createdAt: value(DCTERMS.created),
        modifiedAt: value(DCTERMS.modified),
    };
}

export async function listRetrievalProfiles(handle: GraphHandle): Promise<RetrievalProfileRecord[]> {
    const quads = await readMeta(handle);
    const subjects = new Set<string>();
    for (const q of quads) {
        if (q.predicate.value === RDF.type && q.object.value === OW.RetrievalProfile && q.subject.termType === 'NamedNode') {
            subjects.add(q.subject.value);
        }
    }
    const records: RetrievalProfileRecord[] = [];
    for (const subject of subjects) {
        const record = recordFromQuads(handle, subject, quads);
        if (record) records.push(record);
    }
    return records.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

export async function getRetrievalProfile(handle: GraphHandle, id: string): Promise<RetrievalProfileRecord | null> {
    return recordFromQuads(handle, profileIriFor(handle.iri, id), await readMeta(handle));
}

function profileQuads(record: RetrievalProfileRecord, graph: Quad['graph']): Quad[] {
    const subject = namedNode(record.iri);
    const quads: Quad[] = [
        factory.quad(subject, namedNode(RDF.type), namedNode(OW.RetrievalProfile), graph),
        factory.quad(subject, namedNode(SCHEMA.name), literal(record.name), graph),
        factory.quad(subject, namedNode(OW.retrievalConfig), literal(JSON.stringify(record.config)), graph),
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

async function replaceProfileNodes(handle: GraphHandle, id: string, build: RetrievalProfileRecord | null): Promise<void> {
    const metaGraph = namedNode(handle.iri.sharedGraph('meta'));
    const profileIri = profileIriFor(handle.iri, id);
    const remaining = (await readMeta(handle)).filter(
        q => !(q.subject.termType === 'NamedNode' && q.subject.value === profileIri),
    );
    const next = build ? [...remaining, ...profileQuads(build, metaGraph)] : remaining;
    await handle.store.load(next, metaGraph, { replace: true });
}

function randomSuffix(): string {
    const bytes = new Uint8Array(4);
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export interface CreateRetrievalProfileInput {
    name: string;
    description?: string;
    /** Roh-Parameter — unbekannte Felder werden beim Speichern verworfen. */
    config: unknown;
    /** Nur für Tests: deterministische ID statt Zufallssuffix. */
    id?: string;
}

export async function createRetrievalProfile(
    handle: GraphHandle,
    input: CreateRetrievalProfileInput,
): Promise<RetrievalProfileRecord> {
    const id = input.id ?? `profil-${randomSuffix()}`;
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
        throw new Error(`Ungültige Profil-ID "${id}" (erlaubt: Buchstaben, Ziffern, Bindestriche).`);
    }
    if (await getRetrievalProfile(handle, id)) {
        throw new Error(`Profil-ID "${id}" existiert bereits.`);
    }
    // Unbekannte Felder verwerfen, dann prüfen, dass sich der Parametersatz
    // zu einer gültigen Anfrage vervollständigt — sonst speichert das
    // Profil Müll.
    const config = sanitizeConfig(input.config);
    withRetrievalDefaults(config);
    const now = new Date().toISOString();
    const record: RetrievalProfileRecord = {
        id,
        iri: profileIriFor(handle.iri, id),
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        config,
        createdAt: now,
        modifiedAt: now,
    };
    await handle.store.transaction(async tx => {
        await replaceProfileNodes({ store: tx, iri: handle.iri }, id, record);
    });
    return record;
}

export async function deleteRetrievalProfile(handle: GraphHandle, id: string): Promise<boolean> {
    if (!(await getRetrievalProfile(handle, id))) return false;
    await handle.store.transaction(async tx => {
        await replaceProfileNodes({ store: tx, iri: handle.iri }, id, null);
    });
    return true;
}
