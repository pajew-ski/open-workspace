// @vitest-environment node
/**
 * A1-Abnahme, Teil 2 (ACTIONS_SPEC §6): der Aktionsvertrag im Tool-Pfad.
 *
 *  1. Für jede Aktion ist das an das Modell gelieferte JSON-Schema das aus
 *     ihrem Zod-Schema erzeugte — kein handgeschriebenes Schema mehr im
 *     Tool-Pfad.
 *  2. Eine `destructive`-Aktion taucht in keiner Tool-Liste auf.
 *  3. Server- und Browser-Loop liefern für dieselbe Aktion identische
 *     Definitionen.
 *  4. Identität: Eine über den Server-Loop angelegte Aufgabe landet im
 *     Graphen des anfragenden Nutzers, nicht im Default (Multi-User-Aufbau
 *     wie in tests/graph/multi-user.test.ts).
 *
 * Dazu die Grenze zwischen Sprachmodell und Workspace: Was das Modell an
 * Argumenten liefert, ist Behauptung — die Aktion prüft mit ihrem Schema
 * und meldet den Fehler als Text zurück (der Tool-Loop lebt weiter).
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Quad } from '@rdfjs/types';
import { z } from 'zod';
import { OxigraphStore } from '@/lib/graph/store/oxigraph';
import { createIriFactory, DEFAULT_USER_ID } from '@/lib/graph/iri';
import { namedNode } from '@/lib/graph/rdf';
import { SCHEMA } from '@/lib/graph/vocab';
import { ensureDefaultAuthorizations } from '@/lib/graph/authz/acl-graph';
import { grantForIdentity } from '@/lib/graph/authz/resolve';
import { defaultWorkspaceFilePaths } from '@/lib/graph/workspace/files';
import type { WorkspaceContext } from '@/lib/graph/workspace/crud';
import * as toolsShared from '@/lib/ai/tools.shared';
import '@/lib/actions/catalog';
import { listActions } from '@/lib/actions/registry';
import { inputJsonSchema, toolDefinition } from '@/lib/actions/schema';
import { actionEngineTool, actionEngineTools, visibleToolDefinitions } from '@/lib/actions/tools';
import { engineToolsFromDefinitions } from '@/lib/actions/browser';
import { executeAction } from '@/lib/actions/execute';
import { ActionDeniedError, type ActionContext } from '@/lib/actions/contract';
import { createTask, deleteTask } from '@/lib/graph/workspace/actions';
import { workspaceFinder } from '@/lib/graph/search/actions';
import { accessOverview } from '@/lib/graph/authz/actions';

const INSTANCE_BASE = 'https://ws.example.org/id/';
const alice = createIriFactory(INSTANCE_BASE, 'alice');
const bob = createIriFactory(INSTANCE_BASE, 'bob');
const fallback = createIriFactory(INSTANCE_BASE, DEFAULT_USER_ID);

interface Fixture {
    store: OxigraphStore;
    dir: string;
    ctx: (user: string) => Promise<ActionContext>;
}

let fx: Fixture;

async function fixture(): Promise<Fixture> {
    const store = new OxigraphStore();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-actions-'));
    const handle = { store, iri: alice };
    // Standardregeln wie beim Erstkontakt (server/instance.ts#bootstrapAccess):
    // jeder Nutzergraph gehört seinem Eigentümer — VOR dem ersten Quad.
    await ensureDefaultAuthorizations(handle, {
        admins: ['alice'],
        additionalGraphs: [alice.graph('workspace'), alice.graph('presentation'), bob.graph('workspace'), bob.graph('presentation')],
    });
    const ctx = async (user: string): Promise<ActionContext> => {
        const iri = createIriFactory(INSTANCE_BASE, user);
        const identity = user === ''
            ? { userId: '', groups: [], authenticated: false }
            : { userId: user, groups: [], authenticated: true };
        const grant = await grantForIdentity({ store, iri }, identity, { sparql: true });
        const workspace: WorkspaceContext = {
            store,
            iri,
            paths: defaultWorkspaceFilePaths(path.join(dir, user || 'anon')),
            runExclusive: fn => fn(),
            persistSnapshot: async () => undefined,
        };
        return {
            identity: { userId: user, authenticated: user !== '', label: user || 'anonym' },
            grant,
            graph: { store, iri },
            workspace: async () => workspace,
        };
    };
    return { store, dir, ctx };
}

async function dump(store: OxigraphStore, graph: string): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const quad of store.dump(namedNode(graph))) quads.push(quad);
    return quads;
}

beforeEach(async () => {
    fx = await fixture();
});

afterEach(async () => {
    await fs.rm(fx.dir, { recursive: true, force: true });
});

describe('ACTIONS_SPEC — das Schema kommt aus dem Vertrag', () => {
    it('liefert für jede sichtbare Aktion das aus Zod erzeugte JSON-Schema', async () => {
        const ctx = await fx.ctx('alice');
        const tools = await actionEngineTools(ctx);
        expect(tools.length).toBeGreaterThan(5);
        const byName = new Map(listActions().map(action => [action.name, action]));
        for (const tool of tools) {
            const action = byName.get(tool.name);
            expect(action, `${tool.name} ist keine registrierte Aktion`).toBeDefined();
            const { $schema: _dropped, ...expected } = z.toJSONSchema(action!.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
            void _dropped;
            expect(tool.parameters).toEqual(expected);
            expect(tool.parameters).toEqual(inputJsonSchema(action!));
            expect(tool.source).toBe('builtin');
        }
    });

    it('hat kein handgeschriebenes Workspace-Tool mehr in tools.shared.ts', () => {
        const builders = Object.keys(toolsShared).filter(name => /^make[A-Z]\w*Tool$/.test(name));
        expect(builders).toEqual(['makeUseSkillTool']);
    });

    it('nennt jede Aktion mit einem Namen, den Provider und Marker-Syntax akzeptieren', () => {
        for (const action of listActions()) {
            expect(action.name).toMatch(/^[a-z0-9_]{1,64}$/);
            expect(action.description.trim()).not.toBe('');
            if (action.effect !== 'read') expect(action.changes?.length ?? 0).toBeGreaterThan(0);
        }
    });
});

describe('ACTIONS_SPEC — destructive erscheint auf keiner Agenten-Oberfläche', () => {
    it('hat destruktive Aktionen, listet aber keine davon als Werkzeug', async () => {
        const destructive = listActions().filter(action => action.effect === 'destructive').map(action => action.name);
        expect(destructive).toContain('workspace_delete_task');
        const ctx = await fx.ctx('alice');
        const definitions = await visibleToolDefinitions(ctx);
        expect(definitions.length).toBeGreaterThan(0);
        for (const definition of definitions) {
            expect(destructive, `${definition.name} ist destruktiv und trotzdem gelistet`).not.toContain(definition.name);
            expect(definition.effect).not.toBe('destructive');
        }
        const engineTools = (await actionEngineTools(ctx)).map(tool => tool.name);
        expect(engineTools.some(name => destructive.includes(name))).toBe(false);
    });

    it('macht Aktionen ohne erreichbares Ziel unsichtbar statt scheiternd (Invariante 10)', async () => {
        // Anonym: kein eigener Namensraum, kein Workspace.
        const anonymous = await fx.ctx('');
        const names = (await visibleToolDefinitions(anonymous)).map(definition => definition.name);
        expect(names).not.toContain('workspace_create_task');
        expect(names).not.toContain('workspace_list_tasks');
        // Ohne Workspace-Kontext (etwa ein MCP-Token ohne CRUD) fehlen sie ebenso.
        const alice = await fx.ctx('alice');
        const withoutWorkspace: ActionContext = { ...alice, workspace: undefined };
        expect((await visibleToolDefinitions(withoutWorkspace)).map(d => d.name)).not.toContain('workspace_create_task');
        expect((await visibleToolDefinitions(withoutWorkspace)).map(d => d.name)).toContain('workspace_finder');
        // Der Aufruf selbst wird verweigert, nicht nur die Liste.
        await expect(executeAction(createTask, { title: 'X' }, anonymous)).rejects.toBeInstanceOf(ActionDeniedError);
    });
});

describe('ACTIONS_SPEC — Server- und Browser-Loop sind dieselbe Definition', () => {
    it('liefert identische Name/Beschreibung/Parameter über beide Wege', async () => {
        const ctx = await fx.ctx('alice');
        const server = await actionEngineTools(ctx);
        const served = await visibleToolDefinitions(ctx); // was GET /api/actions ausliefert
        const browser = engineToolsFromDefinitions(JSON.parse(JSON.stringify(served)), async () => new Response('{}'));
        const strip = (tool: { name: string; description: string; parameters: unknown }) =>
            ({ name: tool.name, description: tool.description, parameters: tool.parameters });
        expect(browser.map(strip)).toEqual(server.map(strip));
        expect(browser.every(tool => tool.source === 'builtin')).toBe(true);
    });

    it('reicht im Browser Ergebnis und Signale der Route durch', async () => {
        const ctx = await fx.ctx('alice');
        const [definition] = (await visibleToolDefinitions(ctx)).filter(d => d.name === 'workspace_create_task');
        const calls: Array<{ url: string; body: string }> = [];
        const [tool] = engineToolsFromDefinitions([definition], async (url, init) => {
            calls.push({ url, body: String(init?.body) });
            return new Response(JSON.stringify({
                output: { task: { id: 't-1' } },
                signals: [{ type: 'changes', entityTypes: ['x'] }],
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        });
        const result = await tool.execute({ title: 'Dach decken' });
        expect(calls[0].url).toBe('/api/actions/workspace_create_task');
        expect(JSON.parse(calls[0].body)).toEqual({ title: 'Dach decken' });
        expect(result.text).toContain('t-1');
        expect(result.signals).toEqual([{ type: 'changes', entityTypes: ['x'] }]);
    });

    it('gibt einen Routenfehler wörtlich an das Modell zurück', async () => {
        const [tool] = engineToolsFromDefinitions([toolDefinition(createTask)], async () =>
            new Response(JSON.stringify({ error: 'Validierung fehlgeschlagen', details: [{ path: 'title', message: 'Titel ist erforderlich' }] }), { status: 400 }));
        const result = await tool.execute({});
        expect(result.text).toMatch(/^Fehler: Validierung fehlgeschlagen/);
        expect(result.text).toContain('Titel ist erforderlich');
    });
});

describe('ACTIONS_SPEC — Identität: die Aufgabe landet im Graphen des Anfragenden', () => {
    it('schreibt über den Server-Loop in graph/u/alice/workspace, nicht in den Default', async () => {
        const ctx = await fx.ctx('alice');
        const tool = actionEngineTool(createTask, ctx);
        const result = await tool.execute({ title: 'Dach decken', priority: 'high', description: '' });
        expect(result.text).toContain('Dach decken');
        expect(result.signals).toEqual([{ type: 'changes', entityTypes: [expect.stringContaining('Task')] }]);

        const own = await dump(fx.store, alice.graph('workspace'));
        expect(own.some(q => q.predicate.value === SCHEMA.name && q.object.value === 'Dach decken')).toBe(true);
        expect(await dump(fx.store, fallback.graph('workspace'))).toEqual([]);
        expect(await dump(fx.store, bob.graph('workspace'))).toEqual([]);

        // Und der Finder derselben Identität findet sie; Bob nicht.
        const found = await executeAction(workspaceFinder, { q: 'Dach' }, ctx);
        expect((found.output as { results: Array<{ title: string }> }).results.map(r => r.title)).toContain('Dach decken');
        const bobs = await executeAction(workspaceFinder, { q: 'Dach' }, await fx.ctx('bob'));
        expect((bobs.output as { results: unknown[] }).results).toEqual([]);
    });

    it('prüft die Argumente des Modells mit dem Schema und meldet den Fehler als Text', async () => {
        const ctx = await fx.ctx('alice');
        const tool = actionEngineTool(createTask, ctx);
        expect((await tool.execute({})).text).toMatch(/^Fehler: Validierung fehlgeschlagen/);
        expect((await tool.execute({ title: 'A', priority: 'sofort' })).text).toContain('priority');
        expect(await dump(fx.store, alice.graph('workspace'))).toEqual([]);
    });

    it('verlangt für eine Änderung mindestens ein Feld und eine ID aus dem Finder', async () => {
        const ctx = await fx.ctx('alice');
        const created = await executeAction(createTask, { title: 'A' }, ctx);
        const id = (created.output as { task: { id: string } }).task.id;
        const update = listActions().find(action => action.name === 'workspace_update_task')!;
        expect(update.description).toContain('workspace_finder');
        const updateTool = actionEngineTool(update, ctx);
        expect((await updateTool.execute({ taskId: id })).text).toMatch(/kein zu änderndes Feld/);
        expect((await updateTool.execute({ status: 'done' })).text).toMatch(/taskId/);
        expect((await updateTool.execute({ taskId: id, status: 'done' })).text).toContain('done');
    });

    it('löscht nur über die bestätigte Oberfläche — die Aktion existiert, aber nicht als Werkzeug', async () => {
        const ctx = await fx.ctx('alice');
        const created = await executeAction(createTask, { title: 'Weg damit' }, ctx);
        const id = (created.output as { task: { id: string } }).task.id;
        await executeAction(deleteTask, { id }, ctx);
        expect(await dump(fx.store, alice.graph('workspace'))).toEqual([]);
    });
});

describe('ACTIONS_SPEC — eine migrierte Route behält ihre Antwortform', () => {
    // Regression: `/graph/access` liest `identity.groups.length`, `mode` und
    // `reason`. Fehlt eines davon, rendert die Seite den Fehlerzustand
    // (CI #68). Die Aktion trägt deshalb dieselben Felder wie die Route
    // vor der Migration — auch wenn der Kontext sie nicht kennt.
    it('liefert access_overview mit mode, groups und reason der Identität', async () => {
        const ctx = await fx.ctx('alice');
        const bare = await executeAction(accessOverview, {}, ctx);
        expect(bare.output).toMatchObject({
            identity: { userId: 'alice', authenticated: true, mode: null, groups: [], reason: null },
        });
        const withMode = await executeAction(accessOverview, {}, {
            ...ctx,
            identity: { ...ctx.identity, mode: 'proxy-header', groups: ['team'], reason: 'nur zum Test' },
        });
        expect(withMode.output).toMatchObject({
            identity: { mode: 'proxy-header', groups: ['team'], reason: 'nur zum Test' },
        });
    });
});
