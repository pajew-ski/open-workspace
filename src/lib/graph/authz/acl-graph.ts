/**
 * `graph/acl` — die Rechte als RDF im selben Store wie die Daten
 * (SPEC §17.2, M13).
 *
 * Dieses Modul ist die EINZIGE Stelle, die `graph/acl` liest oder
 * schreibt. Der Graph ist aus jedem Dataset ausgeschlossen (§3.3): keine
 * Query, kein Retrieval, kein Export und kein Connector kommt an ihn
 * heran — auch nicht der Eigentümer. Wer Regeln sehen oder ändern will,
 * geht über die Funktionen hier, und die verlangen `control` auf dem
 * betroffenen Graphen.
 *
 * **Default-Regeln** (§17.2: „Default für jeden neu entstehenden Graphen:
 * nur der Eigentümer, `control`. Nichts ist per Default sichtbar."):
 * `ensureDefaultAuthorizations` legt für jeden Graphen ohne Regel genau
 * die Regel an, die seiner Art entspricht — als Tripel, nicht als
 * Sonderfall im Code. Damit ist auch die Eigentümerschaft prüfbar
 * (`SELECT` auf `graph/acl`), statt in einer if-Bedingung zu leben.
 *
 * Ausnahmen von „nichts ist sichtbar", jede mit Grund:
 *  - `graph/vocab`, `graph/shapes`: das Produktvokabular und seine
 *    Constraints sind öffentlich (`foaf:Agent` Read) — ohne sie kann kein
 *    fremder Client die ausgelieferten Daten deuten (§4.4).
 *  - `graph/meta`: Lesen für angemeldete Nutzer. `meta` trägt das
 *    Selbstmodell der Installation (§18) — Module, Connectors, Skills,
 *    Räume. Es ist instanzweit und ausdrücklich geteilt; nutzerprivate
 *    Inhalte gehören nicht hinein.
 *  - `graph/u/<id>/public`: anonym lesbar (§17.5) — das ist der Zweck.
 */

import type { Quad } from '@rdfjs/types';
import type { GraphStore } from '../store/types';
import { describeGraph, type IriFactory } from '../iri';
import { factory, namedNode, typedLiteral } from '../rdf';
import { ACL, DCTERMS, FOAF, RDF } from '../vocab';
import { aclModeFromIri, aclModeIri, expandModes, modesFor, type AclAuthorization, type AclMode, type AclPrincipal } from './acl';

export interface AclGraphHandle {
    store: GraphStore;
    iri: IriFactory;
}

/** Prinzipal einer Regel in der Form, in der UI und API ihn benennen. */
export type AuthorizationPrincipal =
    | { kind: 'user'; id: string }
    | { kind: 'group'; id: string }
    /** Jeder angemeldete Nutzer (`acl:AuthenticatedAgent`). */
    | { kind: 'authenticated' }
    /** Jeder, auch anonym (`foaf:Agent`). */
    | { kind: 'public' };

export interface AuthorizationRecord {
    id: string;
    iri: string;
    /** Genau ein Named Graph pro Regel — eine Regel, ein Ziel, ein Knopf. */
    graph: string;
    principal: AuthorizationPrincipal;
    modes: AclMode[];
    createdAt?: string;
    /**
     * Beim Start erzeugte Standardregel (§17.2). Sie ist eine gewöhnliche
     * Regel und löschbar — die Markierung dient der Anzeige, nicht der
     * Durchsetzung.
     */
    managed: boolean;
}

const MANAGED_PREFIX = 'default-';

// --- RDF ↔ Modell ---------------------------------------------------------

async function dumpAcl(handle: AclGraphHandle): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const q of handle.store.dump(namedNode(handle.iri.sharedGraph('acl')))) {
        quads.push(q);
    }
    return quads;
}

/**
 * Alle Regeln als pures Modell. Toleriert von Hand (oder per Import)
 * angelegte Regeln mit mehreren `acl:accessTo`-Werten — die
 * Auswertung in `acl.ts` kommt damit zurecht.
 */
export function authorizationsFromQuads(quads: readonly Quad[]): AclAuthorization[] {
    const bySubject = new Map<string, AclAuthorization>();
    const isAuth = new Set<string>();
    for (const q of quads) {
        if (q.subject.termType !== 'NamedNode') continue;
        if (q.predicate.value === RDF.type && q.object.value === ACL.Authorization) {
            isAuth.add(q.subject.value);
        }
    }
    for (const subject of isAuth) {
        bySubject.set(subject, { iri: subject, accessTo: [], agents: [], agentGroups: [], agentClasses: [], modes: [] });
    }
    for (const q of quads) {
        if (q.subject.termType !== 'NamedNode') continue;
        const auth = bySubject.get(q.subject.value);
        if (!auth) continue;
        const push = (key: 'accessTo' | 'agents' | 'agentGroups' | 'agentClasses') => {
            if (q.object.termType !== 'NamedNode') return;
            (auth[key] as string[]).push(q.object.value);
        };
        switch (q.predicate.value) {
            case ACL.accessTo: push('accessTo'); break;
            case ACL.agent: push('agents'); break;
            case ACL.agentGroup: push('agentGroups'); break;
            case ACL.agentClass: push('agentClasses'); break;
            case ACL.mode: {
                const mode = aclModeFromIri(q.object.value);
                if (mode) (auth.modes as AclMode[]).push(mode);
                break;
            }
        }
    }
    return [...bySubject.values()].sort((a, b) => a.iri.localeCompare(b.iri));
}

/** Regeln der Installation (pures Modell — die Basis jeder Entscheidung). */
export async function loadAuthorizations(handle: AclGraphHandle): Promise<AclAuthorization[]> {
    return authorizationsFromQuads(await dumpAcl(handle));
}

function principalTerms(handle: AclGraphHandle, principal: AuthorizationPrincipal): { predicate: string; object: string } {
    switch (principal.kind) {
        case 'user': return { predicate: ACL.agent, object: handle.iri.principal('user', principal.id) };
        case 'group': return { predicate: ACL.agentGroup, object: handle.iri.principal('group', principal.id) };
        case 'authenticated': return { predicate: ACL.agentClass, object: ACL.AuthenticatedAgent };
        case 'public': return { predicate: ACL.agentClass, object: FOAF.Agent };
    }
}

function principalFromAuth(handle: AclGraphHandle, auth: AclAuthorization): AuthorizationPrincipal | null {
    const user = auth.agents.map(a => handle.iri.principalId('user', a)).find((id): id is string => id !== null);
    if (user) return { kind: 'user', id: user };
    const group = auth.agentGroups.map(g => handle.iri.principalId('group', g)).find((id): id is string => id !== null);
    if (group) return { kind: 'group', id: group };
    if (auth.agentClasses.includes(FOAF.Agent)) return { kind: 'public' };
    if (auth.agentClasses.includes(ACL.AuthenticatedAgent)) return { kind: 'authenticated' };
    return null;
}

/** Menschenlesbarer Prinzipal für UI und Fehlermeldungen. */
export function principalLabel(principal: AuthorizationPrincipal): string {
    switch (principal.kind) {
        case 'user': return `Nutzer „${principal.id}"`;
        case 'group': return `Gruppe „${principal.id}"`;
        case 'authenticated': return 'Alle angemeldeten Nutzer';
        case 'public': return 'Öffentlich (auch anonym)';
    }
}

function principalKey(principal: AuthorizationPrincipal): string {
    return principal.kind === 'user' || principal.kind === 'group'
        ? `${principal.kind}-${principal.id}`
        : principal.kind;
}

/** IRI-Segmente enthalten alles Mögliche — IDs bleiben trotzdem lesbar. */
function slug(value: string): string {
    const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return cleaned === '' ? 'x' : cleaned.slice(0, 60);
}

/**
 * Deterministische ID einer Regel: gleicher Graph + gleicher Prinzipal =
 * gleiche ID. Damit ist das Setzen einer Regel idempotent und erzeugt
 * beim wiederholten Start keine Duplikate.
 */
export function authorizationIdFor(handle: AclGraphHandle, graph: string, principal: AuthorizationPrincipal, managed = false): string {
    const described = describeGraph(handle.iri.instanceBase, graph);
    const graphKey = described === null
        ? slug(graph)
        : described.kind === 'user' ? `u-${slug(described.userId)}-${slug(described.scope)}`
            : described.kind === 'space' ? `shared-${slug(described.spaceId)}`
                : slug(described.name);
    return `${managed ? MANAGED_PREFIX : ''}${graphKey}--${principalKey(principal)}`;
}

function recordFromAuth(handle: AclGraphHandle, auth: AclAuthorization, createdAt?: string): AuthorizationRecord | null {
    const id = handle.iri.principalId('authorization', auth.iri);
    const principal = principalFromAuth(handle, auth);
    if (!id || !principal || auth.accessTo.length === 0 || auth.modes.length === 0) return null;
    return {
        id,
        iri: auth.iri,
        graph: auth.accessTo[0],
        principal,
        modes: [...new Set(auth.modes)].sort(),
        ...(createdAt ? { createdAt } : {}),
        managed: id.startsWith(MANAGED_PREFIX),
    };
}

/** Regeln als Datensätze (API/UI). Sortiert: Graph, dann Prinzipal. */
export async function listAuthorizations(handle: AclGraphHandle): Promise<AuthorizationRecord[]> {
    const quads = await dumpAcl(handle);
    const created = new Map<string, string>();
    for (const q of quads) {
        if (q.predicate.value === DCTERMS.created && q.subject.termType === 'NamedNode') {
            created.set(q.subject.value, q.object.value);
        }
    }
    return authorizationsFromQuads(quads)
        .map(auth => recordFromAuth(handle, auth, created.get(auth.iri)))
        .filter((record): record is AuthorizationRecord => record !== null)
        .sort((a, b) => a.graph.localeCompare(b.graph) || a.id.localeCompare(b.id));
}

function authorizationQuads(handle: AclGraphHandle, record: AuthorizationRecord): Quad[] {
    const graph = namedNode(handle.iri.sharedGraph('acl'));
    const subject = namedNode(record.iri);
    const { predicate, object } = principalTerms(handle, record.principal);
    const quads: Quad[] = [
        factory.quad(subject, namedNode(RDF.type), namedNode(ACL.Authorization), graph),
        factory.quad(subject, namedNode(ACL.accessTo), namedNode(record.graph), graph),
        factory.quad(subject, namedNode(predicate), namedNode(object), graph),
    ];
    for (const mode of [...new Set(record.modes)].sort()) {
        quads.push(factory.quad(subject, namedNode(ACL.mode), namedNode(aclModeIri(mode)), graph));
    }
    if (record.createdAt) {
        quads.push(factory.quad(subject, namedNode(DCTERMS.created), typedLiteral.dateTime(record.createdAt), graph));
    }
    return quads;
}

export interface SetAuthorizationInput {
    graph: string;
    principal: AuthorizationPrincipal;
    modes: AclMode[];
    managed?: boolean;
    now?: Date;
}

/**
 * Setzt (oder ersetzt) genau eine Regel. Ohne Modi wird sie entfernt —
 * „keine Rechte" ist kein Regel-Zustand, sondern die Abwesenheit einer
 * Regel.
 */
export async function setAuthorization(
    handle: AclGraphHandle,
    input: SetAuthorizationInput,
): Promise<AuthorizationRecord | null> {
    const id = authorizationIdFor(handle, input.graph, input.principal, input.managed ?? false);
    const record: AuthorizationRecord = {
        id,
        iri: handle.iri.principal('authorization', id),
        graph: input.graph,
        principal: input.principal,
        modes: [...new Set(input.modes)].sort(),
        createdAt: (input.now ?? new Date()).toISOString(),
        managed: input.managed ?? false,
    };
    if (record.modes.length === 0) {
        await deleteAuthorization(handle, id);
        return null;
    }
    await replaceSubject(handle, record.iri, authorizationQuads(handle, record));
    return record;
}

export async function deleteAuthorization(handle: AclGraphHandle, id: string): Promise<boolean> {
    const iri = handle.iri.principal('authorization', id);
    const quads = await dumpAcl(handle);
    if (!quads.some(q => q.subject.termType === 'NamedNode' && q.subject.value === iri)) return false;
    await replaceSubject(handle, iri, []);
    return true;
}

async function replaceSubject(handle: AclGraphHandle, subjectIri: string, next: readonly Quad[]): Promise<void> {
    const aclGraph = namedNode(handle.iri.sharedGraph('acl'));
    const remaining = (await dumpAcl(handle)).filter(
        q => !(q.subject.termType === 'NamedNode' && q.subject.value === subjectIri),
    );
    await handle.store.load([...remaining, ...next], aclGraph, { replace: true });
}

// --- Default-Regeln -------------------------------------------------------

export interface DefaultAclInput {
    /**
     * Nutzer mit `control` auf den instanzweiten Graphen (meta, vocab,
     * shapes). Seed der Installation — danach ist `graph/acl` die Wahrheit.
     */
    admins: readonly string[];
    /** Eigentümer eines Raums (spaceId → userId), aus `graph/meta`. */
    spaceOwners?: ReadonlyMap<string, string>;
    now?: Date;
}

/** Die Regeln, die ein Graph seiner Art nach bekommt (§17.2). */
export function defaultAuthorizationsFor(
    handle: AclGraphHandle,
    graph: string,
    input: DefaultAclInput,
): SetAuthorizationInput[] {
    const described = describeGraph(handle.iri.instanceBase, graph);
    if (described === null) return [];
    const managed = { managed: true, ...(input.now ? { now: input.now } : {}) };
    if (described.kind === 'user') {
        const rules: SetAuthorizationInput[] = [
            { graph, principal: { kind: 'user', id: described.userId }, modes: ['control'], ...managed },
        ];
        if (described.scope === 'public') {
            // §17.5: der öffentliche Teilgraph ist ohne Anmeldung lesbar.
            rules.push({ graph, principal: { kind: 'public' }, modes: ['read'], ...managed });
        }
        return rules;
    }
    if (described.kind === 'space') {
        const owner = input.spaceOwners?.get(described.spaceId);
        return owner ? [{ graph, principal: { kind: 'user', id: owner }, modes: ['control'], ...managed }] : [];
    }
    if (described.name === 'acl') return []; // nie Teil eines Datasets
    const rules: SetAuthorizationInput[] = input.admins.map(admin => ({
        graph,
        principal: { kind: 'user', id: admin } as AuthorizationPrincipal,
        modes: ['control'] as AclMode[],
        ...managed,
    }));
    if (described.name === 'vocab' || described.name === 'shapes') {
        rules.push({ graph, principal: { kind: 'public' }, modes: ['read'], ...managed });
    } else if (described.name === 'meta') {
        rules.push({ graph, principal: { kind: 'authenticated' }, modes: ['read'], ...managed });
    }
    return rules;
}

export interface EnsureDefaultsReport {
    created: AuthorizationRecord[];
}

/**
 * Legt fehlende Standardregeln an — für alle vorhandenen Graphen plus die
 * ausdrücklich genannten (ein Nutzergraph existiert erst, wenn er das
 * erste Quad hat; sein Eigentümer soll trotzdem vorher schon Rechte
 * haben). Bestehende Regeln bleiben unangetastet: die Funktion ist ein
 * Auffüller, kein Zurücksetzer.
 */
export async function ensureDefaultAuthorizations(
    handle: AclGraphHandle,
    input: DefaultAclInput & { additionalGraphs?: readonly string[] },
): Promise<EnsureDefaultsReport> {
    const existing = (await handle.store.graphs()).map(g => g.value);
    const targets = [...new Set([...existing, ...(input.additionalGraphs ?? [])])].sort();
    const current = await listAuthorizations(handle);
    const known = new Set(current.map(record => record.id));
    const created: AuthorizationRecord[] = [];
    for (const graph of targets) {
        for (const rule of defaultAuthorizationsFor(handle, graph, input)) {
            const id = authorizationIdFor(handle, rule.graph, rule.principal, true);
            if (known.has(id)) continue;
            // Auch eine per Hand gesetzte Regel für dieselbe Kombination
            // zählt: sonst überschriebe der Start die Entscheidung des
            // Verwalters bei jedem Neustart.
            const manualId = authorizationIdFor(handle, rule.graph, rule.principal, false);
            if (known.has(manualId)) continue;
            const record = await setAuthorization(handle, rule);
            if (record) {
                known.add(record.id);
                created.push(record);
            }
        }
    }
    return { created };
}

// --- Entscheidungen -------------------------------------------------------

/**
 * Darf dieser Prinzipal die Regeln von `graph` ändern? Genau dann, wenn er
 * `control` darauf hat (§17.2). Es gibt keine Verwalter-Hintertür im Code —
 * Verwalter sind Nutzer mit `control`, und das steht in `graph/acl`.
 */
export function mayControl(
    authorizations: readonly AclAuthorization[],
    principal: AclPrincipal,
    graph: string,
): boolean {
    return modesFor(authorizations, principal, graph).has('control');
}

/** Alle Modi, die ein Prinzipal irgendwo hat — für die Übersicht in der UI. */
export function grantedGraphs(
    authorizations: readonly AclAuthorization[],
    principal: AclPrincipal,
    graphs: readonly string[],
): Array<{ graph: string; modes: AclMode[] }> {
    return graphs
        .map(graph => ({ graph, modes: [...modesFor(authorizations, principal, graph)].sort() }))
        .filter(entry => entry.modes.length > 0);
}

/** Modi-Menge als sortierte Liste (stabile API-Ausgabe). */
export function sortedModes(modes: Iterable<AclMode>): AclMode[] {
    return [...expandModes(modes)].sort();
}

/** Anzeigename eines Graphen (UI, Fehlermeldungen) — nie roh die IRI. */
export function graphLabel(instanceBase: string, graph: string): string {
    const described = describeGraph(instanceBase, graph);
    if (!described) return graph;
    if (described.kind === 'user') return `${described.userId}: ${described.scope}`;
    if (described.kind === 'space') return `Raum ${described.spaceId}`;
    return described.name;
}

