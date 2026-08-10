/**
 * Nutzer, Gruppen und geteilte Räume als Graph-Bürger (SPEC §17.1, M13).
 *
 * Dasselbe Muster wie Connectors (M3), Views (M5), Profile (M8) und
 * Endpoints (M11): die Registry IST der Graph. Alles liegt in
 * `graph/meta` — instanzweit, weil ein Nutzer, eine Gruppe und ein Raum
 * über Nutzergrenzen hinweg benannt werden müssen.
 *
 *     <…/user/alice>  a schema:Person, foaf:Agent ;
 *                     dcterms:identifier "alice" ; schema:name "Alice" .
 *     <…/group/team>  a foaf:Group ; schema:name "Team" ;
 *                     foaf:member <…/user/alice> .
 *     <…/space/lab>   a ow:Space ; schema:name "Labor" ;
 *                     acl:owner <…/user/alice> ;
 *                     ow:spaceGraph <…/graph/shared/lab> .
 *
 * Die **Mitgliederliste eines Raums** ist bewusst KEINE zweite Liste hier,
 * sondern die Menge der ACL-Regeln auf `graph/shared/<id>` (siehe
 * `acl-graph.ts`, Rollen in `acl.ts`). Zwei Listen wären zwei Wahrheiten,
 * und die zweite wäre die falsche.
 */

import type { Quad } from '@rdfjs/types';
import type { GraphStore } from '../store/types';
import type { IriFactory } from '../iri';
import { factory, literal, namedNode, typedLiteral } from '../rdf';
import { ACL, DCTERMS, FOAF, OW, RDF, SCHEMA } from '../vocab';

export interface PrincipalGraphHandle {
    store: GraphStore;
    iri: IriFactory;
}

export const ID_PATTERN = /^[a-z0-9][a-z0-9._@-]*$/i;

export function assertPrincipalId(kind: string, id: string): void {
    if (!ID_PATTERN.test(id) || id.length > 100) {
        throw new Error(
            `Ungültige ${kind}-ID "${id}": erlaubt sind Buchstaben, Ziffern und . _ - @ (max. 100 Zeichen).`,
        );
    }
}

async function dumpMeta(handle: PrincipalGraphHandle): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const q of handle.store.dump(namedNode(handle.iri.sharedGraph('meta')))) {
        quads.push(q);
    }
    return quads;
}

function subjectsOfType(quads: readonly Quad[], type: string): string[] {
    const out = new Set<string>();
    for (const q of quads) {
        if (q.predicate.value === RDF.type && q.object.value === type && q.subject.termType === 'NamedNode') {
            out.add(q.subject.value);
        }
    }
    return [...out].sort();
}

function valueOf(quads: readonly Quad[], subject: string, predicate: string): string | undefined {
    return quads.find(q => q.subject.value === subject && q.predicate.value === predicate)?.object.value;
}

function valuesOf(quads: readonly Quad[], subject: string, predicate: string): string[] {
    return quads
        .filter(q => q.subject.value === subject && q.predicate.value === predicate)
        .map(q => q.object.value)
        .sort();
}

// --- Nutzer ---------------------------------------------------------------

export interface UserRecord {
    id: string;
    iri: string;
    name: string;
    createdAt?: string;
}

export function userQuads(handle: PrincipalGraphHandle, record: UserRecord): Quad[] {
    const graph = namedNode(handle.iri.sharedGraph('meta'));
    const subject = namedNode(record.iri);
    const quads = [
        factory.quad(subject, namedNode(RDF.type), namedNode(SCHEMA.Person), graph),
        factory.quad(subject, namedNode(RDF.type), namedNode(FOAF.Agent), graph),
        factory.quad(subject, namedNode(DCTERMS.identifier), literal(record.id), graph),
        factory.quad(subject, namedNode(SCHEMA.name), literal(record.name), graph),
    ];
    if (record.createdAt) {
        quads.push(factory.quad(subject, namedNode(DCTERMS.created), typedLiteral.dateTime(record.createdAt), graph));
    }
    return quads;
}

export async function listUsers(handle: PrincipalGraphHandle): Promise<UserRecord[]> {
    const quads = await dumpMeta(handle);
    return subjectsOfType(quads, SCHEMA.Person)
        .map((iri): UserRecord | null => {
            const id = handle.iri.principalId('user', iri);
            if (!id) return null;
            const createdAt = valueOf(quads, iri, DCTERMS.created);
            return { id, iri, name: valueOf(quads, iri, SCHEMA.name) ?? id, ...(createdAt ? { createdAt } : {}) };
        })
        .filter((record): record is UserRecord => record !== null)
        .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Legt einen Nutzerknoten an, falls er fehlt. Wird bei jeder erkannten
 * Identität aufgerufen: Wer sich anmeldet, existiert — der Graph soll das
 * wissen, ohne dass jemand ihn von Hand pflegt (§18).
 */
export async function ensureUser(
    handle: PrincipalGraphHandle,
    id: string,
    name?: string,
    now: Date = new Date(),
): Promise<UserRecord> {
    assertPrincipalId('Nutzer', id);
    const iri = handle.iri.principal('user', id);
    const quads = await dumpMeta(handle);
    const existingName = valueOf(quads, iri, SCHEMA.name);
    const existing = quads.some(q => q.subject.value === iri && q.predicate.value === RDF.type);
    const created = valueOf(quads, iri, DCTERMS.created);
    if (existing && (!name || name === existingName)) {
        return { id, iri, name: existingName ?? id, ...(created ? { createdAt: created } : {}) };
    }
    const record: UserRecord = { id, iri, name: name ?? existingName ?? id, createdAt: created ?? now.toISOString() };
    await replaceSubjects(handle, [iri], userQuads(handle, record));
    return record;
}

// --- Gruppen --------------------------------------------------------------

export interface GroupRecord {
    id: string;
    iri: string;
    name: string;
    /** Nutzer-IDs der Mitglieder. */
    members: string[];
    createdAt?: string;
}

export async function listGroups(handle: PrincipalGraphHandle): Promise<GroupRecord[]> {
    const quads = await dumpMeta(handle);
    return subjectsOfType(quads, FOAF.Group)
        .map((iri): GroupRecord | null => {
            const id = handle.iri.principalId('group', iri);
            if (!id) return null;
            const createdAt = valueOf(quads, iri, DCTERMS.created);
            return {
                id,
                iri,
                name: valueOf(quads, iri, SCHEMA.name) ?? id,
                members: valuesOf(quads, iri, FOAF.member)
                    .map(memberIri => handle.iri.principalId('user', memberIri))
                    .filter((memberId): memberId is string => memberId !== null),
                ...(createdAt ? { createdAt } : {}),
            };
        })
        .filter((record): record is GroupRecord => record !== null)
        .sort((a, b) => a.id.localeCompare(b.id));
}

export async function setGroup(
    handle: PrincipalGraphHandle,
    input: { id: string; name?: string; members: string[]; now?: Date },
): Promise<GroupRecord> {
    assertPrincipalId('Gruppen', input.id);
    for (const member of input.members) assertPrincipalId('Nutzer', member);
    const iri = handle.iri.principal('group', input.id);
    const quads = await dumpMeta(handle);
    const graph = namedNode(handle.iri.sharedGraph('meta'));
    const createdAt = valueOf(quads, iri, DCTERMS.created) ?? (input.now ?? new Date()).toISOString();
    const record: GroupRecord = {
        id: input.id,
        iri,
        name: input.name ?? valueOf(quads, iri, SCHEMA.name) ?? input.id,
        members: [...new Set(input.members)].sort(),
        createdAt,
    };
    const next: Quad[] = [
        factory.quad(namedNode(iri), namedNode(RDF.type), namedNode(FOAF.Group), graph),
        factory.quad(namedNode(iri), namedNode(DCTERMS.identifier), literal(record.id), graph),
        factory.quad(namedNode(iri), namedNode(SCHEMA.name), literal(record.name), graph),
        factory.quad(namedNode(iri), namedNode(DCTERMS.created), typedLiteral.dateTime(createdAt), graph),
        ...record.members.map(member => factory.quad(
            namedNode(iri),
            namedNode(FOAF.member),
            namedNode(handle.iri.principal('user', member)),
            graph,
        )),
    ];
    await replaceSubjects(handle, [iri], next);
    return record;
}

export async function deleteGroup(handle: PrincipalGraphHandle, id: string): Promise<boolean> {
    const iri = handle.iri.principal('group', id);
    const quads = await dumpMeta(handle);
    if (!quads.some(q => q.subject.value === iri)) return false;
    await replaceSubjects(handle, [iri], []);
    return true;
}

/** Gruppen-IRIs, in denen dieser Nutzer Mitglied ist (Prinzipal-Auflösung). */
export async function groupsOfUser(handle: PrincipalGraphHandle, userId: string): Promise<string[]> {
    const userIri = handle.iri.principal('user', userId);
    return (await listGroups(handle))
        .filter(group => group.members.includes(userId) || group.members.includes(userIri))
        .map(group => group.iri)
        .sort();
}

// --- Geteilte Räume -------------------------------------------------------

export interface SpaceRecord {
    id: string;
    iri: string;
    name: string;
    /** Named Graph des Raums (`graph/shared/<id>`). */
    graph: string;
    /** Nutzer-ID des Eigentümers. */
    owner: string;
    description?: string;
    createdAt?: string;
}

export async function listSpaces(handle: PrincipalGraphHandle): Promise<SpaceRecord[]> {
    const quads = await dumpMeta(handle);
    return subjectsOfType(quads, OW.Space)
        .map((iri): SpaceRecord | null => {
            const id = handle.iri.principalId('space', iri);
            const ownerIri = valueOf(quads, iri, ACL.owner);
            const owner = ownerIri ? handle.iri.principalId('user', ownerIri) : null;
            if (!id || !owner) return null;
            const description = valueOf(quads, iri, SCHEMA.description);
            const createdAt = valueOf(quads, iri, DCTERMS.created);
            return {
                id,
                iri,
                name: valueOf(quads, iri, SCHEMA.name) ?? id,
                graph: valueOf(quads, iri, OW.spaceGraph) ?? handle.iri.spaceGraph(id),
                owner,
                ...(description ? { description } : {}),
                ...(createdAt ? { createdAt } : {}),
            };
        })
        .filter((record): record is SpaceRecord => record !== null)
        .sort((a, b) => a.id.localeCompare(b.id));
}

export async function getSpace(handle: PrincipalGraphHandle, id: string): Promise<SpaceRecord | null> {
    return (await listSpaces(handle)).find(space => space.id === id) ?? null;
}

export async function createSpace(
    handle: PrincipalGraphHandle,
    input: { id: string; name: string; owner: string; description?: string; now?: Date },
): Promise<SpaceRecord> {
    assertPrincipalId('Raum', input.id);
    assertPrincipalId('Nutzer', input.owner);
    if (await getSpace(handle, input.id)) {
        throw new Error(`Raum-ID "${input.id}" existiert bereits.`);
    }
    const createdAt = (input.now ?? new Date()).toISOString();
    const record: SpaceRecord = {
        id: input.id,
        iri: handle.iri.principal('space', input.id),
        name: input.name,
        graph: handle.iri.spaceGraph(input.id),
        owner: input.owner,
        ...(input.description ? { description: input.description } : {}),
        createdAt,
    };
    const graph = namedNode(handle.iri.sharedGraph('meta'));
    const subject = namedNode(record.iri);
    const quads: Quad[] = [
        factory.quad(subject, namedNode(RDF.type), namedNode(OW.Space), graph),
        factory.quad(subject, namedNode(DCTERMS.identifier), literal(record.id), graph),
        factory.quad(subject, namedNode(SCHEMA.name), literal(record.name), graph),
        factory.quad(subject, namedNode(OW.spaceGraph), namedNode(record.graph), graph),
        factory.quad(subject, namedNode(ACL.owner), namedNode(handle.iri.principal('user', record.owner)), graph),
        factory.quad(subject, namedNode(DCTERMS.created), typedLiteral.dateTime(createdAt), graph),
    ];
    if (record.description) {
        quads.push(factory.quad(subject, namedNode(SCHEMA.description), literal(record.description), graph));
    }
    await replaceSubjects(handle, [record.iri], quads);
    return record;
}

export async function deleteSpace(handle: PrincipalGraphHandle, id: string): Promise<boolean> {
    const space = await getSpace(handle, id);
    if (!space) return false;
    await replaceSubjects(handle, [space.iri], []);
    return true;
}

/** spaceId → Eigentümer-ID (Eingabe für die Default-ACL-Regeln). */
export async function spaceOwners(handle: PrincipalGraphHandle): Promise<Map<string, string>> {
    return new Map((await listSpaces(handle)).map(space => [space.id, space.owner]));
}

// --- gemeinsame Schreibhilfe ---------------------------------------------

async function replaceSubjects(
    handle: PrincipalGraphHandle,
    subjects: readonly string[],
    next: readonly Quad[],
): Promise<void> {
    const metaGraph = namedNode(handle.iri.sharedGraph('meta'));
    const drop = new Set(subjects);
    const remaining = (await dumpMeta(handle)).filter(
        q => !(q.subject.termType === 'NamedNode' && drop.has(q.subject.value)),
    );
    await handle.store.load([...remaining, ...next], metaGraph, { replace: true });
}
