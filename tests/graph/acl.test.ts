// @vitest-environment node
/**
 * M13 — ACL-Modell, Nutzer/Gruppen/Räume, Freigabehandlung und die
 * Durchsetzungs-Architektur (GRAPH_CORE_SPEC §17.1–§17.3, §17.5).
 *
 * Die Test-Matrix aus §17.6 (jede Zeile ein eigener Negativtest) liegt in
 * `multi-user.test.ts`. Hier stehen die Bausteine, auf denen sie ruht:
 *
 *  1. WAC-Auswertung: Prinzipale, Modus-Implikation, „nichts per Default".
 *  2. `graph/acl` als RDF — lesen, setzen, entfernen, Standardregeln.
 *  3. Nutzer, Gruppen, geteilte Räume als Graph-Bürger (§17.1).
 *  4. Freigabehandlung `copy`/`move` mit `prov:Activity` (§17.1).
 *  5. Öffentlicher Teilgraph: VoID + Dereferenzierung (§17.5).
 *  6. Architekturtest zu §17.3: Es gibt keinen Lesepfad am
 *     Dataset-Resolver vorbei.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Quad } from '@rdfjs/types';
import { OxigraphStore } from '@/lib/graph/store/oxigraph';
import { createIriFactory, describeGraph } from '@/lib/graph/iri';
import { factory, literal, namedNode } from '@/lib/graph/rdf';
import { ACL, FOAF, OW, PROV, RDF, SCHEMA } from '@/lib/graph/vocab';
import {
    expandModes,
    modesFor,
    roleFromModes,
    ROLE_MODES,
    type AclAuthorization,
    type AclPrincipal,
} from '@/lib/graph/authz/acl';
import {
    authorizationsFromQuads,
    defaultAuthorizationsFor,
    ensureDefaultAuthorizations,
    deleteAuthorization,
    listAuthorizations,
    loadAuthorizations,
    setAuthorization,
} from '@/lib/graph/authz/acl-graph';
import {
    createSpace,
    ensureUser,
    groupsOfUser,
    listGroups,
    listSpaces,
    listUsers,
    setGroup,
} from '@/lib/graph/authz/principals';
import { grantForIdentity, knowledgeGraphs, ANONYMOUS_IDENTITY } from '@/lib/graph/authz/resolve';
import { publishEntity } from '@/lib/graph/authz/publish';
import { buildVoidDescription, voidQuads } from '@/lib/graph/projection/void';
import { describeEntity, entityHtml } from '@/lib/graph/projection/dereference';
import { restoreAclSnapshot, writeAclSnapshot } from '@/lib/graph/serialize/snapshot';
import { createMemoryFileSystem } from '@/lib/platform/runtime/memfs';

const INSTANCE_BASE = 'https://ws.example.org/id/';
const alice = createIriFactory(INSTANCE_BASE, 'alice');
const bob = createIriFactory(INSTANCE_BASE, 'bob');
const nn = namedNode;

function handleFor(store: OxigraphStore, iri = alice) {
    return { store, iri };
}

const auth = (over: Partial<AclAuthorization> = {}): AclAuthorization => ({
    iri: 'urn:auth:1',
    accessTo: [],
    agents: [],
    agentGroups: [],
    agentClasses: [],
    modes: [],
    ...over,
});

const principal = (over: Partial<AclPrincipal> = {}): AclPrincipal => ({
    agent: alice.principal('user', 'alice'),
    groups: [],
    authenticated: true,
    ...over,
});

describe('M13 — WAC-Auswertung (SPEC §17.2)', () => {
    const graph = alice.graph('workspace');

    it('gibt ohne Regel nichts frei — Default ist leer, nicht „lesbar"', () => {
        expect([...modesFor([], principal(), graph)]).toEqual([]);
    });

    it('trifft Agent, Gruppe, angemeldete und öffentliche Prinzipale', () => {
        const byAgent = auth({ accessTo: [graph], agents: [alice.principal('user', 'alice')], modes: ['read'] });
        const byGroup = auth({ iri: 'urn:auth:2', accessTo: [graph], agentGroups: [alice.principal('group', 'team')], modes: ['append'] });
        const byAuthenticated = auth({ iri: 'urn:auth:3', accessTo: [graph], agentClasses: [ACL.AuthenticatedAgent], modes: ['read'] });
        const byPublic = auth({ iri: 'urn:auth:4', accessTo: [graph], agentClasses: [FOAF.Agent], modes: ['read'] });

        expect(modesFor([byAgent], principal(), graph).has('read')).toBe(true);
        expect(modesFor([byAgent], principal({ agent: bob.principal('user', 'bob') }), graph).has('read')).toBe(false);

        const inTeam = principal({ groups: [alice.principal('group', 'team')] });
        expect(modesFor([byGroup], inTeam, graph).has('append')).toBe(true);
        expect(modesFor([byGroup], principal(), graph).has('append')).toBe(false);

        // `acl:AuthenticatedAgent` trifft nur geprüfte Identitäten.
        expect(modesFor([byAuthenticated], ANONYMOUS_PRINCIPAL, graph).has('read')).toBe(false);
        expect(modesFor([byAuthenticated], principal(), graph).has('read')).toBe(true);
        // `foaf:Agent` trifft jeden, auch anonym — das ist §17.5.
        expect(modesFor([byPublic], ANONYMOUS_PRINCIPAL, graph).has('read')).toBe(true);
    });

    it('setzt die Implikation der Modi um (control ⊃ write ⊃ append/read)', () => {
        expect([...expandModes(['control'])].sort()).toEqual(['append', 'control', 'read', 'write']);
        expect([...expandModes(['write'])].sort()).toEqual(['append', 'read', 'write']);
        // append allein ist die Briefkasten-Semantik aus §17.2: beitragen,
        // ohne den Bestand zu sehen.
        expect([...expandModes(['append'])]).toEqual(['append']);
    });

    it('benennt Rollen aus Modi, ohne eine zweite Rechte-Welt zu bauen', () => {
        expect(roleFromModes(ROLE_MODES.contributor)).toBe('contributor');
        expect(roleFromModes(['control'])).toBe('owner');
        expect(roleFromModes([])).toBeNull();
    });

    it('gilt nur für den genannten Graphen', () => {
        const rule = auth({ accessTo: [graph], agents: [alice.principal('user', 'alice')], modes: ['control'] });
        expect(modesFor([rule], principal(), bob.graph('workspace')).size).toBe(0);
    });
});

const ANONYMOUS_PRINCIPAL: AclPrincipal = { agent: null, groups: [], authenticated: false };

describe('M13 — graph/acl als RDF (SPEC §17.2)', () => {
    it('schreibt WAC-Tripel und liest sie verlustfrei zurück', async () => {
        const store = new OxigraphStore();
        const handle = handleFor(store);
        const record = await setAuthorization(handle, {
            graph: alice.graph('public'),
            principal: { kind: 'user', id: 'bob' },
            modes: ['read', 'append'],
        });
        expect(record?.modes).toEqual(['append', 'read']);

        const quads: Quad[] = [];
        for await (const quad of store.dump(nn(alice.sharedGraph('acl')))) quads.push(quad);
        expect(quads.some(q => q.predicate.value === RDF.type && q.object.value === ACL.Authorization)).toBe(true);
        expect(quads.some(q => q.predicate.value === ACL.accessTo && q.object.value === alice.graph('public'))).toBe(true);
        expect(quads.some(q => q.predicate.value === ACL.agent && q.object.value === alice.principal('user', 'bob'))).toBe(true);
        expect(quads.filter(q => q.predicate.value === ACL.mode)).toHaveLength(2);

        const parsed = authorizationsFromQuads(quads);
        expect(parsed).toHaveLength(1);
        expect([...parsed[0].modes].sort()).toEqual(['append', 'read']);
    });

    it('ist idempotent pro Graph+Prinzipal und löscht bei leerer Modus-Liste', async () => {
        const store = new OxigraphStore();
        const handle = handleFor(store);
        const first = await setAuthorization(handle, {
            graph: alice.graph('public'), principal: { kind: 'user', id: 'bob' }, modes: ['read'],
        });
        const second = await setAuthorization(handle, {
            graph: alice.graph('public'), principal: { kind: 'user', id: 'bob' }, modes: ['read', 'write'],
        });
        expect(second?.id).toBe(first?.id);
        expect(await listAuthorizations(handle)).toHaveLength(1);

        const removed = await setAuthorization(handle, {
            graph: alice.graph('public'), principal: { kind: 'user', id: 'bob' }, modes: [],
        });
        expect(removed).toBeNull();
        expect(await listAuthorizations(handle)).toHaveLength(0);
    });

    it('legt Standardregeln an: Eigentümer control, public anonym lesbar, vocab öffentlich', () => {
        const handle = handleFor(new OxigraphStore());
        const input = { admins: ['alice'] };

        const workspace = defaultAuthorizationsFor(handle, alice.graph('workspace'), input);
        expect(workspace).toHaveLength(1);
        expect(workspace[0].principal).toEqual({ kind: 'user', id: 'alice' });
        expect(workspace[0].modes).toEqual(['control']);

        const publicGraph = defaultAuthorizationsFor(handle, alice.graph('public'), input);
        expect(publicGraph.map(rule => rule.principal.kind).sort()).toEqual(['public', 'user']);

        const vocab = defaultAuthorizationsFor(handle, alice.sharedGraph('vocab'), input);
        expect(vocab.some(rule => rule.principal.kind === 'public' && rule.modes.includes('read'))).toBe(true);

        // graph/acl bekommt NIE eine Regel — er ist aus jedem Dataset raus.
        expect(defaultAuthorizationsFor(handle, alice.sharedGraph('acl'), input)).toEqual([]);
    });

    it('füllt nur auf und überschreibt keine Entscheidung des Verwalters', async () => {
        const store = new OxigraphStore();
        const handle = handleFor(store);
        await store.load([factory.quad(nn(alice.entity('doc', 'a')), nn(RDF.type), nn(OW.Document), nn(alice.graph('workspace')))], nn(alice.graph('workspace')));

        const first = await ensureDefaultAuthorizations(handle, { admins: ['alice'] });
        expect(first.created.length).toBeGreaterThan(0);
        const second = await ensureDefaultAuthorizations(handle, { admins: ['alice'] });
        expect(second.created).toEqual([]);

        // Manuell entfernte Standardregel bleibt entfernt.
        const managed = (await listAuthorizations(handle)).find(rule => rule.graph === alice.graph('workspace'));
        await deleteAuthorization(handle, managed!.id);
        // …aber eine per Hand gesetzte Regel für dieselbe Kombination wird
        // auch nicht dupliziert.
        await setAuthorization(handle, {
            graph: alice.graph('workspace'), principal: { kind: 'user', id: 'alice' }, modes: ['read'],
        });
        const third = await ensureDefaultAuthorizations(handle, { admins: ['alice'] });
        expect(third.created).toEqual([]);
        const rules = (await listAuthorizations(handle)).filter(rule => rule.graph === alice.graph('workspace'));
        expect(rules).toHaveLength(1);
        expect(rules[0].modes).toEqual(['read']);
    });

    it('überlebt einen Neustart über acl.nq — außerhalb des Manifests', async () => {
        const store = new OxigraphStore();
        const handle = handleFor(store);
        await setAuthorization(handle, {
            graph: alice.graph('public'), principal: { kind: 'user', id: 'bob' }, modes: ['read'],
        });
        const fs = createMemoryFileSystem();
        await writeAclSnapshot(store, fs, '/data/graph', nn(alice.sharedGraph('acl')));
        expect(await fs.exists('/data/graph/acl.nq')).toBe(true);

        const restored = new OxigraphStore();
        const report = await restoreAclSnapshot(restored, fs, '/data/graph', nn(alice.sharedGraph('acl')));
        expect(report?.quads).toBeGreaterThan(0);
        const rules = await loadAuthorizations(handleFor(restored));
        expect(rules[0].accessTo).toEqual([alice.graph('public')]);
    });
});

describe('M13 — Nutzer, Gruppen und Räume (SPEC §17.1)', () => {
    it('macht Nutzer zu schema:Person/foaf:Agent in graph/meta', async () => {
        const store = new OxigraphStore();
        const handle = handleFor(store);
        const user = await ensureUser(handle, 'alice', 'Alice Anders');
        expect(user.iri).toBe(`${INSTANCE_BASE}user/alice`);

        const quads: Quad[] = [];
        for await (const quad of store.dump(nn(alice.sharedGraph('meta')))) quads.push(quad);
        expect(quads.some(q => q.object.value === SCHEMA.Person)).toBe(true);
        expect(quads.some(q => q.object.value === FOAF.Agent)).toBe(true);

        // Zweiter Aufruf ändert nichts (idempotent).
        await ensureUser(handle, 'alice', 'Alice Anders');
        expect(await listUsers(handle)).toHaveLength(1);
    });

    it('trägt Gruppen als foaf:Group mit foaf:member', async () => {
        const store = new OxigraphStore();
        const handle = handleFor(store);
        await setGroup(handle, { id: 'team', name: 'Team', members: ['alice', 'bob'] });
        const groups = await listGroups(handle);
        expect(groups[0].members).toEqual(['alice', 'bob']);
        expect(await groupsOfUser(handle, 'alice')).toEqual([alice.principal('group', 'team')]);
        expect(await groupsOfUser(handle, 'carol')).toEqual([]);
    });

    it('legt Räume als ow:Space mit acl:owner und ow:spaceGraph an', async () => {
        const store = new OxigraphStore();
        const handle = handleFor(store);
        const space = await createSpace(handle, { id: 'labor', name: 'Labor', owner: 'alice' });
        expect(space.graph).toBe(`${INSTANCE_BASE}graph/shared/labor`);
        expect(describeGraph(INSTANCE_BASE, space.graph)).toEqual({ kind: 'space', spaceId: 'labor' });

        const quads: Quad[] = [];
        for await (const quad of store.dump(nn(alice.sharedGraph('meta')))) quads.push(quad);
        expect(quads.some(q => q.predicate.value === ACL.owner && q.object.value === alice.principal('user', 'alice'))).toBe(true);
        expect(quads.some(q => q.predicate.value === OW.spaceGraph && q.object.value === space.graph)).toBe(true);
        expect((await listSpaces(handle))[0].owner).toBe('alice');

        await expect(createSpace(handle, { id: 'labor', name: 'Zweitbelegung', owner: 'bob' }))
            .rejects.toThrow(/existiert bereits/);
    });

    it('leitet Prinzipale aus Graph-Mitgliedschaft UND Anbieter-Gruppen ab', async () => {
        const store = new OxigraphStore();
        const handle = handleFor(store);
        await setGroup(handle, { id: 'team', name: 'Team', members: ['alice'] });
        await setAuthorization(handle, {
            graph: bob.graph('workspace'), principal: { kind: 'group', id: 'team' }, modes: ['read'],
        });
        await setAuthorization(handle, {
            graph: bob.graph('public'), principal: { kind: 'group', id: 'extern' }, modes: ['read'],
        });
        await store.load(
            [factory.quad(nn(bob.entity('doc', 'x')), nn(SCHEMA.name), literal('Bobs Notiz'), nn(bob.graph('workspace')))],
            nn(bob.graph('workspace')),
        );
        await store.load(
            [factory.quad(nn(bob.entity('doc', 'y')), nn(SCHEMA.name), literal('Bobs Öffentliches'), nn(bob.graph('public')))],
            nn(bob.graph('public')),
        );

        const viaGraph = await grantForIdentity(handle, { userId: 'alice', groups: [], authenticated: true });
        expect(viaGraph.readableGraphs).toContain(bob.graph('workspace'));

        // Gruppe aus dem Identitätsanbieter (OIDC-Claim) wirkt genauso.
        const viaProvider = await grantForIdentity(handle, { userId: 'carol', groups: ['extern'], authenticated: true });
        expect(viaProvider.readableGraphs).toEqual([bob.graph('public')]);
    });
});

describe('M13 — Freigabehandlung (SPEC §17.1)', () => {
    async function storeWithDoc(): Promise<OxigraphStore> {
        const store = new OxigraphStore();
        const workspace = nn(alice.graph('workspace'));
        const doc = nn(alice.entity('doc', 'notiz'));
        const reifier = nn(alice.entity('link', 'l1'));
        await store.load([
            factory.quad(doc, nn(RDF.type), nn(OW.Document), workspace),
            factory.quad(doc, nn(SCHEMA.name), literal('Meine Notiz'), workspace),
            factory.quad(doc, nn(OW.linksTo), nn(alice.entity('doc', 'andere')), workspace),
            factory.quad(reifier, nn(RDF.reifies), factory.quad(doc, nn(OW.linksTo), nn(alice.entity('doc', 'andere'))), workspace),
            factory.quad(reifier, nn(OW.weight), literal('2'), workspace),
            factory.quad(nn(alice.entity('doc', 'andere')), nn(SCHEMA.name), literal('Andere Notiz'), workspace),
        ], workspace);
        return store;
    }

    it('kopiert den Knoten samt Kanten-Annotation und protokolliert prov:Activity', async () => {
        const store = await storeWithDoc();
        const report = await publishEntity(handleFor(store), {
            entityIri: alice.entity('doc', 'notiz'),
            mode: 'copy',
            actor: 'alice',
            now: new Date('2026-08-10T08:00:00.000Z'),
        });
        expect(report.mode).toBe('copy');

        const publicQuads: Quad[] = [];
        for await (const quad of store.dump(nn(alice.graph('public')))) publicQuads.push(quad);
        expect(publicQuads.some(q => q.object.value === 'Meine Notiz')).toBe(true);
        // Der Reifier der annotierten Kante kommt mit.
        expect(publicQuads.some(q => q.predicate.value === OW.weight)).toBe(true);
        // Fremde Aussagen bleiben, wo sie waren.
        expect(publicQuads.some(q => q.object.value === 'Andere Notiz')).toBe(false);
        expect(publicQuads.some(q => q.predicate.value === RDF.type && q.object.value === PROV.Activity)).toBe(true);
        expect(publicQuads.some(q => q.predicate.value === PROV.wasAttributedTo && q.object.value === alice.principal('user', 'alice'))).toBe(true);

        // copy heißt: die Quelle behält ihren Bestand.
        const workspaceQuads: Quad[] = [];
        for await (const quad of store.dump(nn(alice.graph('workspace')))) workspaceQuads.push(quad);
        expect(workspaceQuads.some(q => q.object.value === 'Meine Notiz')).toBe(true);
    });

    it('verschiebt bei mode=move und lässt die Quelle ohne den Knoten zurück', async () => {
        const store = await storeWithDoc();
        await publishEntity(handleFor(store), {
            entityIri: alice.entity('doc', 'notiz'),
            mode: 'move',
            actor: 'alice',
            now: new Date('2026-08-10T08:00:00.000Z'),
        });
        const workspaceQuads: Quad[] = [];
        for await (const quad of store.dump(nn(alice.graph('workspace')))) workspaceQuads.push(quad);
        expect(workspaceQuads.some(q => q.object.value === 'Meine Notiz')).toBe(false);
        expect(workspaceQuads.some(q => q.object.value === 'Andere Notiz')).toBe(true);
    });

    it('lehnt eine leere Freigabe ehrlich ab statt still nichts zu tun', async () => {
        const store = await storeWithDoc();
        await expect(publishEntity(handleFor(store), {
            entityIri: alice.entity('doc', 'gibtsnicht'),
            mode: 'copy',
            actor: 'alice',
        })).rejects.toThrow(/nichts freizugeben/);
    });
});

describe('M13 — öffentlicher Teilgraph (SPEC §17.5)', () => {
    async function publicStore(): Promise<OxigraphStore> {
        const store = new OxigraphStore();
        const pub = nn(alice.graph('public'));
        await store.load([
            factory.quad(nn(alice.entity('doc', 'offen')), nn(RDF.type), nn(OW.Document), pub),
            factory.quad(nn(alice.entity('doc', 'offen')), nn(SCHEMA.name), literal('Offene Notiz'), pub),
        ], pub);
        await store.load([
            factory.quad(nn(alice.entity('doc', 'privat')), nn(SCHEMA.name), literal('Private Notiz'), nn(alice.graph('workspace'))),
        ], nn(alice.graph('workspace')));
        await ensureDefaultAuthorizations(handleFor(store), { admins: ['alice'] });
        return store;
    }

    it('beschreibt genau das erlaubte Dataset als void:Dataset', async () => {
        const store = await publicStore();
        const anonymous = await grantForIdentity(handleFor(store), ANONYMOUS_IDENTITY);
        expect(anonymous.readableGraphs).toContain(alice.graph('public'));
        expect(anonymous.readableGraphs).not.toContain(alice.graph('workspace'));

        const description = await buildVoidDescription(store, alice, anonymous.readableGraphs);
        expect(description.partitions.map(p => p.graph)).toContain(alice.graph('public'));
        expect(description.partitions.map(p => p.graph)).not.toContain(alice.graph('workspace'));
        expect(description.partitions.find(p => p.graph === alice.graph('public'))?.classes).toContain(OW.Document);

        const quads = voidQuads(description);
        expect(quads.some(q => q.object.value === 'http://rdfs.org/ns/void#Dataset')).toBe(true);
    });

    it('dereferenziert eine öffentliche Entität und schweigt über private', async () => {
        const store = await publicStore();
        const anonymous = await grantForIdentity(handleFor(store), ANONYMOUS_IDENTITY);

        const open = await describeEntity(store, alice.entity('doc', 'offen'), anonymous.readableGraphs);
        expect(open.some(q => q.object.value === 'Offene Notiz')).toBe(true);
        expect(entityHtml(alice.entity('doc', 'offen'), open)).toContain('Offene Notiz');

        const hidden = await describeEntity(store, alice.entity('doc', 'privat'), anonymous.readableGraphs);
        const missing = await describeEntity(store, alice.entity('doc', 'gibtsnicht'), anonymous.readableGraphs);
        // Gesperrt und nicht existent sind ununterscheidbar (§17.3).
        expect(hidden).toEqual([]);
        expect(hidden).toEqual(missing);
    });
});

describe('M13 — Wissens-Graphen und Architektur (SPEC §17.3)', () => {
    it('spannt den Traversal-Raum über alle Nutzer und Räume auf', () => {
        const existing = [
            alice.graph('workspace'),
            alice.graph('presentation'),
            alice.inferredGraph('workspace'),
            bob.graph('public'),
            bob.importGraph('quelle'),
            alice.spaceGraph('labor'),
            alice.sharedGraph('meta'),
            alice.sharedGraph('vocab'),
            alice.sharedGraph('acl'),
        ];
        expect(knowledgeGraphs(INSTANCE_BASE, existing)).toEqual([
            alice.graph('workspace'),
            alice.sharedGraph('meta'),
            alice.spaceGraph('labor'),
            bob.graph('public'),
            bob.importGraph('quelle'),
        ].sort());
    });

    /**
     * §17.3: „Ein direkter `store.query()`-Aufruf außerhalb des Resolvers
     * ist ein Review-Blocker und wird per Lint-Regel oder Architekturtest
     * verhindert." Das ist dieser Test: Jede Datei, die den Store direkt
     * abfragt, muss ihr Dataset nachweislich vom Resolver beziehen.
     */
    it('kennt keinen Lesepfad am Dataset-Resolver vorbei', () => {
        const roots = [
            path.join(process.cwd(), 'src', 'lib', 'graph'),
            path.join(process.cwd(), 'src', 'app', 'api'),
        ];
        const files: string[] = [];
        const walk = (dir: string) => {
            for (const entry of readdirSync(dir)) {
                const full = path.join(dir, entry);
                if (statSync(full).isDirectory()) walk(full);
                else if (full.endsWith('.ts')) files.push(full);
            }
        };
        for (const root of roots) walk(root);

        /** Die Store-Bindung selbst ist der Adressat, nicht der Aufrufer. */
        const storeImplementations = ['store/oxigraph.ts', 'store/memory.ts'];
        const offenders: string[] = [];
        for (const file of files) {
            const source = readFileSync(file, 'utf8');
            if (!/\.query\(/.test(source)) continue;
            if (storeImplementations.some(suffix => file.endsWith(suffix.replace('/', path.sep)))) continue;
            const resolves = /resolveDataset|retrievalDataset|defaultGraphs:/.test(source);
            if (!resolves) offenders.push(path.relative(process.cwd(), file));
        }
        expect(offenders).toEqual([]);
    });
});
