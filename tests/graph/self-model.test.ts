// @vitest-environment node
/**
 * M14-Abnahme, Teil 1 (GRAPH_CORE_SPEC §18): Das Selbstmodell.
 *
 *  1. Der Workspace beschreibt sich in `graph/meta` — Module, Seiten,
 *     Entitätstypen, Connector-Arten, aktive Runtime-Fähigkeiten,
 *     Schema-Version — und die Fragen „was kann dieses System" und
 *     „welche Module gibt es" sind per SPARQL beantwortbar.
 *  2. Es wird aus dem CODE erzeugt: Keine Seite darf in der Registry
 *     fehlen und kein Registry-Eintrag ohne Seite existieren — sonst wäre
 *     die Registry die vierte Wahrheit, vor der §18 warnt.
 *  3. Deterministisch: derselbe Input erzeugt dieselben Quads, ein
 *     zweiter Lauf meldet „unverändert" (diff-stabile Snapshots, §8.1).
 *  4. Ehrlich: Ein Modul, dessen Runtime-Fähigkeit fehlt, erscheint nicht
 *     (Invariante 10).
 *  5. Der Systemkontext des Assistenten kommt aus dieser Abfrage — ein
 *     neu registriertes Modul ist ihm damit ohne Prompt-Pflege bekannt,
 *     und die früher gepflegten Modul-Tabellen existieren nicht mehr.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Quad } from '@rdfjs/types';
import { OxigraphStore } from '@/lib/graph/store/oxigraph';
import { createIriFactory } from '@/lib/graph/iri';
import { namedNode } from '@/lib/graph/rdf';
import { OW, SCHEMA, SPARQL_PREFIXES } from '@/lib/graph/vocab';
import { canonicalNQuads } from '@/lib/graph/serialize/canonical';
import { APP_MODULES, navigationModules } from '@/lib/app/modules';
import {
    activeCapabilities,
    availableModules,
    replaceSelfModel,
    selfModelQuads,
    SELF_MODEL_APP_ID,
    type SelfModelInput,
} from '@/lib/graph/meta/self-model';
import { readSelfModel } from '@/lib/graph/meta/self-model-query';
import { moduleForPath, systemContextText } from '@/lib/graph/meta/self-model-view';
import { replaceAiMirror } from '@/lib/graph/meta/ai';
import type { RuntimeCapabilities } from '@/lib/platform/runtime/types';

const INSTANCE_BASE = 'urn:ow:12345678-1234-1234-1234-123456789abc:';
const iri = createIriFactory(INSTANCE_BASE);

const SERVER_CAPABILITIES: RuntimeCapabilities = {
    sparqlEndpoint: true,
    mcpServer: true,
    federationOutbound: true,
    federationInbound: true,
    multiUser: true,
    reasoningTier: 'rl',
};

const LOCAL_CAPABILITIES: RuntimeCapabilities = {
    sparqlEndpoint: false,
    mcpServer: false,
    federationOutbound: false,
    federationInbound: false,
    multiUser: false,
    reasoningTier: 'rl',
};

function input(over: Partial<SelfModelInput> = {}): SelfModelInput {
    return {
        runtime: 'server',
        capabilities: SERVER_CAPABILITIES,
        appVersion: '0.1.0',
        schemaVersion: 2,
        modules: APP_MODULES,
        connectorKinds: ['github-rdf', 'obsidian-vault', 'rdf-file'],
        ...over,
    };
}

async function loadSelfModel(store: OxigraphStore, over: Partial<SelfModelInput> = {}) {
    await replaceSelfModel({ store, iri }, input(over));
}

async function select(store: OxigraphStore, sparql: string): Promise<Array<Record<string, string>>> {
    const meta = namedNode(iri.sharedGraph('meta'));
    const result = await store.query(`${SPARQL_PREFIXES}\n${sparql}`, {
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

describe('M14 — Selbstmodell in graph/meta (SPEC §18)', () => {
    it('beantwortet per SPARQL, was das System ist und welche Module es hat', async () => {
        const store = new OxigraphStore();
        await loadSelfModel(store);

        const app = await select(store, `
            SELECT ?name ?runtime ?version ?schemaVersion WHERE { GRAPH <${iri.sharedGraph('meta')}> {
                ?app a schema:SoftwareApplication ; ow:runtime ?runtime ; schema:name ?name ;
                     schema:softwareVersion ?version ; schema:schemaVersion ?schemaVersion .
            } }`);
        expect(app).toHaveLength(1);
        expect(app[0]).toMatchObject({
            name: 'Open Workspace',
            runtime: 'server',
            version: '0.1.0',
            schemaVersion: '2',
        });

        const capabilities = (await select(store, `
            SELECT ?c WHERE { GRAPH <${iri.sharedGraph('meta')}> { ?app ow:capability ?c } } ORDER BY ?c`))
            .map(row => row.c);
        expect(capabilities).toContain('sparqlEndpoint');
        expect(capabilities).toContain('multiUser');
        expect(capabilities).toContain('reasoning:rl');

        const modules = (await select(store, `
            SELECT ?route WHERE { GRAPH <${iri.sharedGraph('meta')}> { ?m a ow:Module ; ow:route ?route } }
            ORDER BY ?route`)).map(row => row.route);
        expect(modules).toContain('/tasks');
        expect(modules).toContain('/onboarding');
        expect(modules).toContain('/graph/sparql');
    });

    it('beantwortet „wo verwalte ich diesen Entitätstyp" über ow:entityType', async () => {
        const store = new OxigraphStore();
        await loadSelfModel(store);
        const rows = await select(store, `
            SELECT ?route WHERE { GRAPH <${iri.sharedGraph('meta')}> {
                ?m a ow:Module ; ow:route ?route ; ow:entityType <${OW.Task}> .
            } }`);
        expect(rows.map(row => row.route)).toEqual(['/tasks']);
    });

    it('hängt Untermodule an ihr Modul und Module an die Anwendung', async () => {
        const store = new OxigraphStore();
        await loadSelfModel(store);
        const rows = await select(store, `
            SELECT ?parent WHERE { GRAPH <${iri.sharedGraph('meta')}> {
                ?m ow:route "/graph/sparql" ; schema:isPartOf ?parent .
            } }`);
        expect(rows.map(row => row.parent)).toEqual([iri.entity('module', 'graph')]);

        const top = await select(store, `
            SELECT ?parent WHERE { GRAPH <${iri.sharedGraph('meta')}> {
                ?m ow:route "/graph" ; schema:isPartOf ?parent .
            } }`);
        expect(top.map(row => row.parent)).toEqual([iri.entity('app', SELF_MODEL_APP_ID)]);
    });

    it('behauptet nur, was die Runtime kann: ohne Fähigkeit kein Modul', () => {
        const local = availableModules(APP_MODULES, LOCAL_CAPABILITIES).map(m => m.route);
        expect(local).not.toContain('/graph/sparql');
        expect(local).not.toContain('/graph/access');
        expect(local).toContain('/graph');
        expect(local).toContain('/onboarding');

        const server = availableModules(APP_MODULES, SERVER_CAPABILITIES).map(m => m.route);
        expect(server).toContain('/graph/sparql');

        expect(activeCapabilities(LOCAL_CAPABILITIES)).toEqual(['reasoning:rl']);
    });

    it('ist deterministisch und meldet einen unveränderten Lauf als unverändert', async () => {
        const first = await canonicalNQuads(selfModelQuads(iri, input()));
        const second = await canonicalNQuads(selfModelQuads(iri, input()));
        expect(second).toBe(first);

        const store = new OxigraphStore();
        const initial = await replaceSelfModel({ store, iri }, input());
        expect(initial.changed).toBe(true);
        const again = await replaceSelfModel({ store, iri }, input());
        expect(again.changed).toBe(false);
        const changed = await replaceSelfModel({ store, iri }, input({ appVersion: '0.2.0' }));
        expect(changed.changed).toBe(true);
    });

    it('ersetzt nur den eigenen Abschnitt von graph/meta', async () => {
        const store = new OxigraphStore();
        await replaceAiMirror({ store, iri }, { skills: [], agents: [], apiTools: [], mcpServers: [], providers: [], defaults: {} });
        const beforeMirror = await dump(store);
        await loadSelfModel(store);
        const afterMirror = await dump(store);

        // Der Anbieter-Knoten des AI-Spiegels überlebt das Selbstmodell …
        const provider = iri.entity('tool-provider', 'workspace');
        expect(afterMirror.filter(q => q.subject.value === provider).length)
            .toBe(beforeMirror.filter(q => q.subject.value === provider).length);

        // … und der AI-Spiegel räumt umgekehrt das Selbstmodell nicht weg.
        await replaceAiMirror({ store, iri }, { skills: [], agents: [], apiTools: [], mcpServers: [], providers: [], defaults: {} });
        const app = await select(store, `
            SELECT ?app WHERE { GRAPH <${iri.sharedGraph('meta')}> { ?app a ow:Module } } LIMIT 1`);
        expect(app.length).toBe(1);
    });

    it('liefert das Lesemodell nur, soweit das Dataset es erlaubt (§17.3)', async () => {
        const store = new OxigraphStore();
        await loadSelfModel(store);

        const full = await readSelfModel(store, iri);
        expect(full.app?.name).toBe('Open Workspace');
        expect(full.modules.length).toBeGreaterThan(0);

        // Ohne Leserecht auf graph/meta: leer statt Fehler oder Umgehung.
        const blocked = await readSelfModel(store, iri, { allowedGraphs: [iri.graph('workspace')] });
        expect(blocked.app).toBeNull();
        expect(blocked.modules).toEqual([]);
    });
});

describe('M14 — Selbstmodell und Code können nicht auseinanderlaufen (§18)', () => {
    /** Statische Routen unter src/app (dynamische Segmente ausgenommen). */
    function pageRoutes(): string[] {
        const appDir = path.join(process.cwd(), 'src', 'app');
        const routes: string[] = [];
        const walk = (dir: string, route: string) => {
            for (const entry of readdirSync(dir)) {
                const full = path.join(dir, entry);
                if (statSync(full).isDirectory()) {
                    if (entry.startsWith('[') || entry === 'api') continue;
                    walk(full, `${route}/${entry}`);
                } else if (entry === 'page.tsx') {
                    routes.push(route === '' ? '/' : route);
                }
            }
        };
        walk(appDir, '');
        return routes.sort();
    }

    it('kennt jede Seite der Anwendung — und keine, die es nicht gibt', () => {
        const routes = pageRoutes();
        const registered = APP_MODULES.map(module => module.route).sort();
        expect(registered).toEqual(routes);
    });

    it('hat eindeutige Kennungen, Routen und einen auflösbaren Elternbezug', () => {
        const ids = APP_MODULES.map(module => module.id);
        expect(new Set(ids).size).toBe(ids.length);
        const routes = APP_MODULES.map(module => module.route);
        expect(new Set(routes).size).toBe(routes.length);
        for (const entry of APP_MODULES) {
            if (entry.partOf) expect(ids).toContain(entry.partOf);
        }
        // Die Navigation zieht aus derselben Registry.
        expect(navigationModules('primary').map(m => m.route)).toContain('/tasks');
        expect(navigationModules('secondary').map(m => m.route)).toEqual(['/onboarding', '/settings']);
    });

    it('löst den längsten Präfix auf — /graph/sparql ist nicht /graph', () => {
        // Dieselbe Auflösung für Registry und abgefragtes Selbstmodell —
        // es gibt nur eine Implementierung.
        expect(moduleForPath(APP_MODULES, '/graph/sparql')?.id).toBe('graph-sparql');
        expect(moduleForPath(APP_MODULES, '/graph')?.id).toBe('graph');
        expect(moduleForPath(APP_MODULES, '/canvas/abc')?.id).toBe('canvas');
        expect(moduleForPath(APP_MODULES, '/')?.id).toBe('dashboard');
        expect(moduleForPath(APP_MODULES, '/gibtesnicht')).toBeNull();
    });

    /**
     * §18: „Das ersetzt handgepflegte Kontextlisten." Genau das prüft
     * dieser Test — eine zweite Modul-Tabelle im Client-Code wäre der
     * Rückfall, den der Abschnitt ausschließt.
     */
    it('hat keine handgepflegte Modul-Tabelle mehr im Client-Code', () => {
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const entry of readdirSync(dir)) {
                const full = path.join(dir, entry);
                if (statSync(full).isDirectory()) walk(full);
                // Die Erwähnung im Kommentar ist Geschichtsschreibung; eine
                // Deklaration wäre der Rückfall.
                else if (/\.tsx?$/.test(full) && /(const|let|var)\s+MODULE_CONTEXT/.test(readFileSync(full, 'utf8'))) {
                    offenders.push(path.relative(process.cwd(), full));
                }
            }
        };
        walk(path.join(process.cwd(), 'src'));
        expect(offenders).toEqual([]);
    });
});

describe('M14 — Systemkontext des Assistenten (SPEC §18)', () => {
    it('entsteht aus der Abfrage und kennt ein neu registriertes Modul', async () => {
        const store = new OxigraphStore();
        await loadSelfModel(store, {
            modules: [
                ...APP_MODULES,
                {
                    id: 'labor',
                    route: '/labor',
                    label: 'Labor',
                    description: 'Ein Modul, das es gestern noch nicht gab.',
                    entityTypes: [SCHEMA.CreativeWork],
                    navigation: 'primary',
                },
            ],
        });
        const view = await readSelfModel(store, iri);
        const text = systemContextText(view, '/labor');

        expect(text).toContain('Open Workspace');
        expect(text).toContain('Runtime server');
        expect(text).toContain('Labor [/labor]: Ein Modul, das es gestern noch nicht gab.');
        expect(text).toContain('Der Nutzer ist gerade hier: Labor [/labor]');
        expect(moduleForPath(view.modules, '/labor')?.label).toBe('Labor');
    });

    it('behauptet ohne Selbstmodell nichts über das System', () => {
        expect(systemContextText({ app: null, modules: [] }, '/tasks')).toBe('');
    });
});

async function dump(store: OxigraphStore): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const quad of store.dump(namedNode(iri.sharedGraph('meta')))) quads.push(quad);
    return quads;
}
