// @vitest-environment node
/**
 * M14-Abnahme, Teil 2 (GRAPH_CORE_SPEC §18): die Einführungsstrecke.
 *
 * „Kein separates Tutorial-Format, sondern reale Aktionen im echten
 * Graphen mit Rückgängig-Möglichkeit." Genau das wird hier geprüft:
 *
 *  1. Alle vier Schritte laufen über die REGULÄREN Pfade — Selbstmodell
 *     abfragen, Dokument über die Store-first-CRUD anlegen, prima-materia
 *     über den EINEN Connector-Vertrag importieren, Herkunft zählen.
 *  2. Der Fortschritt ist RDF (`ow:OnboardingStep` in `graph/meta`) und
 *     per SPARQL abfragbar — kein UI-Zustand.
 *  3. Rückgängig stellt den Vorzustand her: der kanonische Dump (RDFC-1.0)
 *     vor der Strecke und nach dem Zurücknehmen ist byte-identisch, und
 *     die Datei-Projektion ist ebenfalls wieder weg.
 *  4. Nativ, importiert und inferiert bleiben getrennt — der Import landet
 *     nie im Workspace-Graphen.
 *  5. Ein fehlgeschlagener Import wird NICHT als erledigt verbucht
 *     (Invariante 10: keine vorgetäuschten Erfolge).
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import type { Quad } from '@rdfjs/types';
import { OxigraphStore } from '@/lib/graph/store/oxigraph';
import { createIriFactory } from '@/lib/graph/iri';
import { namedNode } from '@/lib/graph/rdf';
import { OW, PROV, SPARQL_PREFIXES } from '@/lib/graph/vocab';
import { canonicalNQuads } from '@/lib/graph/serialize/canonical';
import * as crud from '@/lib/graph/workspace/crud';
import { defaultWorkspaceFilePaths } from '@/lib/graph/workspace/files';
import { replaceSelfModel } from '@/lib/graph/meta/self-model';
import { APP_MODULES } from '@/lib/app/modules';
import { listOnboardingRecords } from '@/lib/graph/onboarding/record';
import {
    onboardingState,
    performOnboardingStep,
    provenanceSummary,
    undoOnboardingStep,
    OnboardingError,
    type OnboardingDeps,
} from '@/lib/graph/onboarding/run';
import { ONBOARDING_STEPS, PRIMA_MATERIA } from '@/lib/graph/onboarding/steps';
import { ensureDefaultAuthorizations } from '@/lib/graph/authz/acl-graph';
import { grantForIdentity } from '@/lib/graph/authz/resolve';
import type { RuntimeCapabilities } from '@/lib/platform/runtime/types';

const INSTANCE_BASE = 'urn:ow:12345678-1234-1234-1234-123456789abc:';
const iri = createIriFactory(INSTANCE_BASE);

const CAPABILITIES: RuntimeCapabilities = {
    sparqlEndpoint: true,
    mcpServer: true,
    federationOutbound: true,
    federationInbound: true,
    multiUser: true,
    reasoningTier: 'rl',
};

const API = 'https://api.github.com/repos/pajew-ski/prima-materia';
const SHA = 'abc123def456';

function githubStub(options: { fail?: boolean } = {}): typeof fetch {
    const raw = (file: string) => `https://raw.githubusercontent.com/pajew-ski/prima-materia/${SHA}/${file}`;
    const routes = new Map<string, () => Response>([
        [API, () => json({ default_branch: 'main' })],
        [`${API}/commits/main`, () => json({ sha: SHA })],
        [`${API}/commits/HEAD`, () => json({ sha: SHA })],
        [`${API}/git/trees/${SHA}?recursive=1`, () => json({
            truncated: false,
            tree: [{ path: 'ontology/begriffe.ttl', type: 'blob', size: 120 }],
        })],
        [raw('ontology/begriffe.ttl'), () => new Response(
            '<https://example.org/prima/materia> <https://schema.org/name> "Materia" .',
            { status: 200, headers: { 'content-type': 'text/plain' } },
        )],
    ]);
    return (async (input: RequestInfo | URL) => {
        if (options.fail) return new Response('kaputt', { status: 500 });
        const route = routes.get(String(input));
        return route ? route() : new Response('not found', { status: 404 });
    }) as typeof fetch;
}

function json(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

let deps: OnboardingDeps;
let baseDir: string;

async function createDeps(options: { fail?: boolean } = {}): Promise<OnboardingDeps> {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-onboarding-'));
    const store = new OxigraphStore();
    // Das Selbstmodell entsteht sonst beim Start der Instanz.
    await replaceSelfModel({ store, iri }, {
        runtime: 'server',
        capabilities: CAPABILITIES,
        appVersion: '0.1.0',
        schemaVersion: 2,
        modules: APP_MODULES,
        connectorKinds: ['github-rdf'],
    });
    let chain: Promise<unknown> = Promise.resolve();
    const workspace: crud.WorkspaceContext = {
        store,
        iri,
        paths: defaultWorkspaceFilePaths(baseDir),
        runExclusive: fn => {
            const run = chain.then(fn);
            chain = run.catch(() => undefined);
            return run;
        },
        persistSnapshot: async () => undefined,
    };
    let tick = 0;
    return {
        handle: { store, iri },
        workspace,
        sync: { fetchImpl: githubStub(options), now: () => new Date(Date.UTC(2026, 7, 10, 12, 0, tick += 1)) },
        now: () => '2026-08-10T12:00:00.000Z',
    };
}

/**
 * Alle behaupteten Quads des Stores. Inferenz-Graphen bleiben draußen:
 * Sie werden nach §8.1 nie persistiert, entstehen bei jedem Lauf neu und
 * tragen einen Zeitstempel — sie sind Ableitung, kein Vorzustand.
 */
async function dumpAsserted(): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const quad of deps.handle.store.dump()) {
        if (quad.graph.value.includes('/inferred/')) continue;
        quads.push(quad);
    }
    return quads;
}

async function metaRows(sparql: string): Promise<Array<Record<string, string>>> {
    const meta = namedNode(iri.sharedGraph('meta'));
    const result = await deps.handle.store.query(`${SPARQL_PREFIXES}\n${sparql}`, {
        defaultGraphs: [meta],
        namedGraphs: [meta],
    });
    if (result.type !== 'bindings') return [];
    const rows: Array<Record<string, string>> = [];
    for await (const row of result.bindings) {
        const entry: Record<string, string> = {};
        for (const [key, term] of Object.entries(row)) entry[key] = term.value;
        rows.push(entry);
    }
    return rows;
}

describe('M14 — Einführungsstrecke: reale Aktionen (SPEC §18)', () => {
    beforeEach(async () => {
        deps = await createDeps();
    });

    it('startet mit vier offenen Schritten und leerer Herkunft', async () => {
        const state = await onboardingState(deps);
        expect(state.steps.map(step => step.id)).toEqual(ONBOARDING_STEPS.map(step => step.id));
        expect(state.steps.every(step => !step.done)).toBe(true);
        expect(state.selfModel.app?.name).toBe('Open Workspace');
        expect(state.provenance.native).toEqual([]);
    });

    it('Schritt 1 fragt das Selbstmodell wirklich ab und hält den Blick als prov:used fest', async () => {
        const state = await performOnboardingStep(deps, 'self-model');
        const step = state.steps.find(s => s.id === 'self-model');
        expect(step?.done).toBe(true);
        expect(step?.used).toEqual([iri.entity('app', 'workspace')]);

        const rows = await metaRows(`
            SELECT ?id ?used WHERE { GRAPH <${iri.sharedGraph('meta')}> {
                ?step a ow:OnboardingStep ; dcterms:identifier ?id ; prov:used ?used .
            } }`);
        expect(rows).toEqual([{ id: 'self-model', used: iri.entity('app', 'workspace') }]);
    });

    it('Schritt 2 legt ein echtes Dokument an — Store und Datei-Projektion', async () => {
        const state = await performOnboardingStep(deps, 'own-node');
        const step = state.steps.find(s => s.id === 'own-node');
        expect(step?.done).toBe(true);
        expect(step?.generated).toHaveLength(1);

        const docs = await crud.listDocs(deps.workspace);
        expect(docs.map(doc => doc.title)).toEqual(['Mein erster Knoten']);
        const file = path.join(deps.workspace.paths.docsDir, `${docs[0].slug}.md`);
        expect(await fs.readFile(file, 'utf-8')).toContain('Mein erster Knoten');

        // Der Knoten liegt im Workspace-Graphen des Nutzers, sonst nirgends.
        expect(state.provenance.native.map(bucket => bucket.scope)).toContain('workspace');
        expect(state.provenance.imported).toEqual([]);
    });

    it('Schritt 2 ist idempotent: zweimal ausführen legt kein zweites Dokument an', async () => {
        await performOnboardingStep(deps, 'own-node');
        await performOnboardingStep(deps, 'own-node');
        expect(await crud.listDocs(deps.workspace)).toHaveLength(1);
        expect(await listOnboardingRecords(deps.handle)).toHaveLength(1);
    });

    it('Schritt 3 importiert prima-materia in den Import-Graphen, nicht in den eigenen', async () => {
        const state = await performOnboardingStep(deps, 'import');
        const step = state.steps.find(s => s.id === 'import');
        expect(step?.done).toBe(true);
        expect(step?.generated).toEqual([iri.entity('connector', PRIMA_MATERIA.connectorId)]);

        const imported: Quad[] = [];
        for await (const quad of deps.handle.store.dump(namedNode(iri.importGraph(PRIMA_MATERIA.connectorId)))) {
            imported.push(quad);
        }
        expect(imported.some(quad => quad.object.value === 'Materia')).toBe(true);

        const workspace: Quad[] = [];
        for await (const quad of deps.handle.store.dump(namedNode(iri.graph('workspace')))) workspace.push(quad);
        expect(workspace.some(quad => quad.object.value === 'Materia')).toBe(false);

        // Provenienz des Imports steht am Import-Graphen (M3-Regel gilt weiter).
        expect(imported.some(quad =>
            quad.predicate.value === PROV.wasDerivedFrom
            && quad.object.value.includes('prima-materia'))).toBe(true);
    });

    it('Schritt 4 trennt nativ, importiert und inferiert', async () => {
        await performOnboardingStep(deps, 'own-node');
        await performOnboardingStep(deps, 'import');
        const state = await performOnboardingStep(deps, 'provenance');

        const step = state.steps.find(s => s.id === 'provenance');
        expect(step?.done).toBe(true);

        const summary = await provenanceSummary(deps.handle);
        expect(summary.native.map(bucket => bucket.scope)).toEqual(['workspace']);
        expect(summary.imported.map(bucket => bucket.scope)).toEqual([`import/${PRIMA_MATERIA.connectorId}`]);
        expect(summary.native[0].statements).toBeGreaterThan(0);
        expect(summary.imported[0].statements).toBeGreaterThan(0);
        // Inferiertes ist eine eigene Herkunft in eigenen Graphen (der
        // Import-Lauf hat den Reasoner mitgebracht) — und es steht in
        // KEINEM behaupteten Graphen: asserted ≠ inferred (Invariante 3).
        expect(summary.inferred.length).toBeGreaterThan(0);
        expect(summary.inferred.every(bucket => bucket.scope.startsWith('inferred/'))).toBe(true);
        const assertedGraphs = [...summary.native, ...summary.imported].map(bucket => bucket.graph);
        expect(summary.inferred.some(bucket => assertedGraphs.includes(bucket.graph))).toBe(false);
        // Layout ist Präsentation, kein Wissen: es taucht nirgends auf.
        expect([...summary.native, ...summary.imported].some(b => b.scope === 'presentation')).toBe(false);
    });

    it('verlangt vor dem Herkunftsvergleich, dass es etwas zu vergleichen gibt', async () => {
        await expect(performOnboardingStep(deps, 'provenance')).rejects.toBeInstanceOf(OnboardingError);
        expect(await listOnboardingRecords(deps.handle)).toEqual([]);
    });
});

describe('M14 — Rückgängig stellt den Vorzustand her (SPEC §18)', () => {
    beforeEach(async () => {
        deps = await createDeps();
    });

    it('nimmt die ganze Strecke zurück — kanonisch byte-identisch zum Vorzustand', async () => {
        const before = await canonicalNQuads(await dumpAsserted());

        for (const step of ONBOARDING_STEPS) {
            await performOnboardingStep(deps, step.id);
        }
        const done = await onboardingState(deps);
        expect(done.steps.every(step => step.done)).toBe(true);

        for (const step of [...ONBOARDING_STEPS].reverse()) {
            await undoOnboardingStep(deps, step.id);
        }
        const after = await canonicalNQuads(await dumpAsserted());
        expect(after).toBe(before);

        const state = await onboardingState(deps);
        expect(state.steps.every(step => !step.done)).toBe(true);
        expect(await crud.listDocs(deps.workspace)).toEqual([]);
        expect(await fs.readdir(deps.workspace.paths.docsDir)).toEqual([]);
    });

    it('löscht mit dem Import auch dessen Graphen — der Connector hinterlässt nichts', async () => {
        await performOnboardingStep(deps, 'import');
        const graphsWith = (await deps.handle.store.graphs()).map(node => node.value);
        expect(graphsWith).toContain(iri.importGraph(PRIMA_MATERIA.connectorId));

        await undoOnboardingStep(deps, 'import');
        const graphsWithout = (await deps.handle.store.graphs()).map(node => node.value);
        expect(graphsWithout).not.toContain(iri.importGraph(PRIMA_MATERIA.connectorId));

        const rows = await metaRows(`
            SELECT ?c WHERE { GRAPH <${iri.sharedGraph('meta')}> { ?c a <${OW.Connector}> } }`);
        expect(rows).toEqual([]);
    });

    it('nimmt einen Schritt zurück, der nichts erzeugt hat, ohne Kollateralschaden', async () => {
        await performOnboardingStep(deps, 'own-node');
        await performOnboardingStep(deps, 'self-model');
        await undoOnboardingStep(deps, 'self-model');

        const state = await onboardingState(deps);
        expect(state.steps.find(step => step.id === 'self-model')?.done).toBe(false);
        expect(state.steps.find(step => step.id === 'own-node')?.done).toBe(true);
        expect(await crud.listDocs(deps.workspace)).toHaveLength(1);
    });
});

describe('M14 — Fehlschläge werden nicht als Erfolg verbucht (Invariante 10)', () => {
    it('meldet einen gescheiterten Import und lässt den Schritt offen', async () => {
        deps = await createDeps({ fail: true });
        await expect(performOnboardingStep(deps, 'import')).rejects.toBeInstanceOf(OnboardingError);

        const state = await onboardingState(deps);
        expect(state.steps.find(step => step.id === 'import')?.done).toBe(false);
        // Der Connector bleibt bestehen, damit ein zweiter Versuch ein Klick
        // ist — sichtbar in der Verwaltung, nicht heimlich.
        const rows = await metaRows(`
            SELECT ?c WHERE { GRAPH <${iri.sharedGraph('meta')}> { ?c a <${OW.Connector}> } }`);
        expect(rows).toHaveLength(1);
    });
});

describe('M14 — Graphen, die erst zur Laufzeit entstehen, sind sichtbar (§17.2)', () => {
    /**
     * Der Grant kommt ausschließlich aus `graph/acl`, und die
     * Standardregeln entstehen beim Start. Ein Import-Graph, der danach
     * angelegt wird, hätte ohne Nachziehen keine Regel — und wäre bis zum
     * nächsten Neustart unsichtbar. Genau das prüft dieser Test: erst der
     * Zustand ohne Nachziehen (leer), dann mit.
     */
    it('bekommt seine Standardregel nachgezogen — sonst bliebe der Import unsichtbar', async () => {
        deps = await createDeps();
        const identity = { userId: iri.userId, groups: [], authenticated: true };

        // Zustand „beim Start": Regeln für den vorhandenen Bestand.
        await ensureDefaultAuthorizations(deps.handle, { admins: [iri.userId] });

        await performOnboardingStep(deps, 'import');
        const importGraph = iri.importGraph(PRIMA_MATERIA.connectorId);

        const before = await grantForIdentity(deps.handle, identity);
        expect(before.readableGraphs).not.toContain(importGraph);

        await ensureDefaultAuthorizations(deps.handle, { admins: [iri.userId] });
        const after = await grantForIdentity(deps.handle, identity);
        expect(after.readableGraphs).toContain(importGraph);

        // Und erst damit zählt der Herkunftsvergleich den Import mit.
        const summary = await provenanceSummary(deps.handle, { allowedGraphs: after.readableGraphs });
        expect(summary.imported.map(bucket => bucket.graph)).toEqual([importGraph]);
    });
});
