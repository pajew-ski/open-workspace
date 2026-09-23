// @vitest-environment node
/**
 * A3-Abnahme (ACTIONS_SPEC §5): Kontext und Rückfluss.
 *
 *  1. `view_screen` liefert den JETZIGEN Zustand der Oberfläche — im
 *     Browser-Loop über Getter, die zwischen zwei Aufrufen im selben Turn
 *     etwas anderes sagen dürfen; die Antwort nennt ihre Frische.
 *  2. `navigate` prüft die Route gegen die Modul-Registry und gibt eine
 *     Navigationsabsicht als Signal zurück, die die Engine als Ereignis
 *     nach außen trägt.
 *  3. Nach einer schreibenden Aktion trägt der Stream ein Änderungs-
 *     ereignis mit den `changes` der Aktion; der Client invalidiert die
 *     betroffenen Queries und benachrichtigt die fetch-basierten Seiten.
 *  4. Beide Oberflächen-Aktionen gibt es nur mit Oberfläche (MCP: nein),
 *     und der Browser führt sie lokal aus, nicht über die Route.
 */
import { describe, expect, it } from 'vitest';
import type { AdapterEvent, EngineMessage } from '@/lib/ai/types';
import { runEngineTurn, type EngineEvent, type EngineTool } from '@/lib/ai/engine';
import { OxigraphStore } from '@/lib/graph/store/oxigraph';
import { createIriFactory } from '@/lib/graph/iri';
import { OW } from '@/lib/graph/vocab';
import '@/lib/actions/catalog';
import type { ActionContext, ActionSurface } from '@/lib/actions/contract';
import { executeAction } from '@/lib/actions/execute';
import { actionEngineTool, visibleToolDefinitions } from '@/lib/actions/tools';
import { engineToolsFromDefinitions } from '@/lib/actions/browser';
import { toolDefinition } from '@/lib/actions/schema';
import { navigate, runSurfaceAction, viewScreen } from '@/lib/assistant/actions';
import { applyWorkspaceChanges, queryKeysFor, WORKSPACE_CHANGE_EVENT } from '@/lib/assistant/changes';

const INSTANCE_BASE = 'https://ws.example.org/id/';
const iri = createIriFactory(INSTANCE_BASE, 'alice');

function liveSurface(): { surface: ActionSurface; state: { pathname: string; viewState: Record<string, unknown> } } {
    const state = { pathname: '/tasks', viewState: { tasks: { visible: 3 } } };
    return {
        state,
        surface: {
            pathname: () => state.pathname,
            viewState: () => state.viewState,
            module: () => ({ label: 'Aufgaben', description: 'Aufgaben und Projekte.' }),
            activeSurface: () => [{ id: 'w1', type: 'WorkspaceTasks' }],
            freshness: 'live',
        },
    };
}

function ctxWith(surface?: ActionSurface): ActionContext {
    return {
        identity: { userId: 'alice', authenticated: true, label: 'alice' },
        grant: { identity: 'alice', readableGraphs: [], writableGraph: null, sparql: false },
        graph: { store: new OxigraphStore(), iri },
        ...(surface ? { surface } : {}),
    };
}

/** Ein Modell, das genau einen Tool-Aufruf macht und dann schweigt. */
function scriptedStream(call: { name: string; args: unknown }) {
    let round = 0;
    return async function* (): AsyncGenerator<AdapterEvent, void, unknown> {
        round += 1;
        if (round === 1) {
            yield { type: 'toolCall', call: { id: 'c1', name: call.name, args: JSON.stringify(call.args) } };
        } else {
            yield { type: 'text', text: 'Erledigt.' };
        }
        yield { type: 'done' };
    };
}

async function runWithTool(tool: EngineTool, call: { name: string; args: unknown }): Promise<EngineEvent[]> {
    const events: EngineEvent[] = [];
    const stream = scriptedStream(call);
    const history: EngineMessage[] = [{ role: 'user', content: 'mach' }];
    await runEngineTurn(history, {
        stream: () => stream(),
        tools: [tool],
        nativeTools: true,
        onEvent: event => events.push(event),
    });
    return events;
}

describe('A3 — view_screen liest den jetzigen Zustand', () => {
    it('liefert Seite, Modul, viewState und Bühne — und meldet, wie frisch das ist', async () => {
        const { surface, state } = liveSurface();
        const first = await executeAction(viewScreen, {}, ctxWith(surface));
        expect(first.output).toMatchObject({
            pathname: '/tasks',
            module: { label: 'Aufgaben' },
            viewState: { tasks: { visible: 3 } },
            activeSurface: [{ id: 'w1', type: 'WorkspaceTasks' }],
            freshness: 'live',
        });
        // Mitten im Turn navigiert der Nutzer: Der zweite Aufruf sieht das.
        state.pathname = '/docs';
        state.viewState = { docs: { selected: 'doc-1' } };
        const second = await executeAction(viewScreen, {}, ctxWith(surface));
        expect(second.output).toMatchObject({ pathname: '/docs', viewState: { docs: { selected: 'doc-1' } } });
        expect(first.signals).toEqual([]);
    });

    it('gibt es nur mit Oberfläche — ohne sie ist die Aktion unsichtbar (Invariante 10)', async () => {
        const without = (await visibleToolDefinitions(ctxWith())).map(definition => definition.name);
        expect(without).not.toContain('view_screen');
        expect(without).not.toContain('navigate');
        const withSurface = (await visibleToolDefinitions(ctxWith(liveSurface().surface))).map(definition => definition.name);
        expect(withSurface).toContain('view_screen');
        expect(withSurface).toContain('navigate');
    });
});

describe('A3 — navigate ist eine Absicht, die das Widget ausführt', () => {
    it('kennt nur Routen der Modul-Registry und baut die Query sauber', async () => {
        const { surface } = liveSurface();
        const result = await executeAction(navigate, { pathname: '/tasks', query: { id: 'task-1', x: 'a b' } }, ctxWith(surface));
        expect(result.output).toMatchObject({
            navigation: { pathname: '/tasks', search: '?id=task-1&x=a+b' },
            module: { id: 'tasks', label: expect.any(String) },
        });
        expect(result.signals).toContainEqual({ type: 'navigate', pathname: '/tasks', search: '?id=task-1&x=a+b' });
        await expect(executeAction(navigate, { pathname: '/gibtesnicht' }, ctxWith(surface)))
            .rejects.toMatchObject({ status: 404 });
    });

    it('kommt als Ereignis aus der Engine — auf dem Server wie im Browser', async () => {
        const { surface } = liveSurface();
        // Server-Loop: Engine-Tool im Prozess.
        const server = await runWithTool(actionEngineTool(navigate, ctxWith(surface)), { name: 'navigate', args: { pathname: '/graph/causal' } });
        expect(server).toContainEqual({ type: 'navigate', pathname: '/graph/causal' });
        // Browser-Loop: dieselbe Definition, lokal ausgeführt, kein Netz.
        let fetched = 0;
        const [tool] = engineToolsFromDefinitions([toolDefinition(navigate)], async () => { fetched += 1; return new Response('{}'); }, {
            navigate: async args => {
                const local = await runSurfaceAction(navigate, args, surface);
                return { text: JSON.stringify(local.output), signals: local.signals };
            },
        });
        const browser = await runWithTool(tool, { name: 'navigate', args: { pathname: '/docs' } });
        expect(browser).toContainEqual({ type: 'navigate', pathname: '/docs' });
        expect(fetched).toBe(0);
    });
});

describe('A3 — Rückfluss nach einer schreibenden Aktion', () => {
    it('trägt die changes der Aktion als Ereignis aus der Engine', async () => {
        const events: EngineEvent[] = [];
        const tool: EngineTool = {
            name: 'workspace_create_task',
            description: 'x',
            parameters: { type: 'object' },
            source: 'builtin',
            execute: async () => ({ text: 'ok', signals: [{ type: 'changes', entityTypes: [OW.Task] }] }),
        };
        const stream = scriptedStream({ name: 'workspace_create_task', args: { title: 'A' } });
        await runEngineTurn([{ role: 'user', content: 'leg an' }], {
            stream: () => stream(), tools: [tool], nativeTools: true, onEvent: event => events.push(event),
        });
        expect(events).toContainEqual({ type: 'changes', entityTypes: [OW.Task] });
    });

    it('invalidiert die betroffenen Queries und benachrichtigt die Seiten — ohne Polling', () => {
        expect(queryKeysFor([OW.Task])).toEqual([['a2ui-stats'], ['a2ui-tasks'], ['activity']]);
        expect(queryKeysFor([OW.Document, OW.Task])).toEqual([['a2ui-docs'], ['a2ui-stats'], ['a2ui-tasks'], ['activity']]);
        // Ein unbekannter Typ berührt nur das Aktivitätslog — nie „alles".
        expect(queryKeysFor(['urn:fremd'])).toEqual([['activity']]);

        const invalidated: unknown[] = [];
        const dispatched: Event[] = [];
        applyWorkspaceChanges(
            { invalidateQueries: async (filters: unknown) => { invalidated.push(filters); } } as never,
            [OW.Task],
            { dispatchEvent: event => { dispatched.push(event); return true; } },
        );
        expect(invalidated).toEqual([{ queryKey: ['a2ui-stats'] }, { queryKey: ['a2ui-tasks'] }, { queryKey: ['activity'] }]);
        expect(dispatched).toHaveLength(1);
        expect(dispatched[0].type).toBe(WORKSPACE_CHANGE_EVENT);
        expect((dispatched[0] as CustomEvent).detail).toEqual({ entityTypes: [OW.Task] });
    });
});
