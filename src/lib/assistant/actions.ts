/**
 * Aktionen des Assistenten-Moduls (ACTIONS_SPEC §5, A3): Kontext und
 * Rückfluss.
 *
 *  - `view_screen` liefert, was der Nutzer gerade sieht. Bis A3 wurde der
 *    `viewState` nur zu Beginn einer Anfrage in den Prompt gepusht und war
 *    mitten im Loop veraltet. Im Browser-Loop liest die Aktion jetzt den
 *    JETZIGEN Zustand (die Oberfläche reicht Getter herein); im Server-Loop
 *    gibt es keinen Rückkanal in den Browser, dort ist es der Stand der
 *    Anfrage — und die Antwort sagt, welches von beiden.
 *  - `navigate` gibt eine Navigationsabsicht zurück, die das Chat-Widget
 *    ausführt, ohne seinen Zustand zu verlieren (CHAT_WIDGET_SPEC §1.3).
 *    Ziel ist eine Route aus der Modul-Registry — der Assistent kann
 *    nirgendwohin führen, was es nicht gibt.
 *
 * Beide zielen auf die Oberfläche des Aufrufers. Ohne Oberfläche (MCP,
 * Tests ohne Widget) gibt es sie nicht (Invariante 10). Diese Datei ist
 * frei von Store und Server: Der Browser-Loop führt sie lokal aus.
 */

import { z } from 'zod';
import { defineAction, notFound, type ActionContext, type ActionSurface } from '@/lib/actions/contract';
import { parseActionInput } from '@/lib/actions/execute';
import { registerActions } from '@/lib/actions/registry';
import { APP_MODULES } from '@/lib/app/modules';
import { moduleForPath } from '@/lib/graph/meta/self-model-view';
import type { GraphHandle } from '@/lib/graph/search/retrieval';
import { OW } from '@/lib/graph/vocab';

export const VIEW_SCREEN_TOOL_NAME = 'view_screen';
export const NAVIGATE_TOOL_NAME = 'navigate';

function surfaceOf(ctx: ActionContext): ActionSurface {
    // `requires: ['surface']` garantiert die Oberfläche (authorize.ts).
    return ctx.surface!;
}

export const viewScreen = defineAction({
    name: VIEW_SCREEN_TOOL_NAME,
    title: 'Aktuelle Ansicht lesen',
    description:
        'Liefert, was der Nutzer gerade sieht: Seite, Modul, den Zustand der Ansicht (viewState) und die ' +
        'Komponenten auf der Bühne. Nutze es, bevor du dich auf „das hier" oder „die Liste" beziehst.',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'surface' },
    requires: ['surface'],
    async run(_input, ctx) {
        const surface = surfaceOf(ctx);
        return {
            pathname: surface.pathname(),
            module: surface.module(),
            viewState: surface.viewState(),
            activeSurface: surface.activeSurface(),
            /**
             * `live`: der Zustand von jetzt (Browser-Loop). `request`: der
             * Stand vom Anfang der Anfrage (Server-Loop) — eine Navigation
             * im selben Turn ist darin noch nicht zu sehen.
             */
            freshness: surface.freshness,
        };
    },
});

export const navigateInputSchema = z.object({
    pathname: z.string().min(1).max(200).describe('Route eines Moduls, z. B. /tasks oder /graph/causal'),
    query: z.record(z.string().max(100), z.string().max(500)).optional()
        .describe('Query-Parameter, z. B. { "id": "task-…" } oder { "projectId": "…" }'),
});

export const navigate = defineAction({
    name: NAVIGATE_TOOL_NAME,
    title: 'Zu einer Seite führen',
    description:
        'Führt den Nutzer zu einer Seite des Workspace (Route aus dem Selbstmodell, optional mit Query wie ?id=…). ' +
        'Der Chat bleibt dabei offen. Nutze es, wenn der Nutzer etwas sehen will, statt es zu beschreiben.',
    input: navigateInputSchema,
    effect: 'constructive',
    target: { kind: 'surface' },
    requires: ['surface'],
    // Es ändert die Oberfläche, nicht den Graphen — dazu gehört kein Entitätstyp;
    // die Klasse steht für „verändert den Zustand des Aufrufers".
    changes: [OW.Module],
    async run(input) {
        const target = moduleForPath(APP_MODULES, input.pathname);
        if (!target) throw notFound(`"${input.pathname}" ist keine Seite dieses Workspace.`);
        const search = input.query && Object.keys(input.query).length > 0
            ? `?${new URLSearchParams(input.query).toString()}`
            : '';
        return {
            navigation: { pathname: input.pathname, search },
            module: { id: target.id, label: target.label, route: target.route },
        };
    },
    signals: output => [{ type: 'navigate', pathname: output.navigation.pathname, ...(output.navigation.search ? { search: output.navigation.search } : {}) }],
});

export const SURFACE_ACTIONS = [viewScreen, navigate] as const;

registerActions('assistant', [...SURFACE_ACTIONS]);

/**
 * Kontext für die lokale Ausführung im Browser-Loop: nur die Oberfläche.
 * Der Graph ist dort nicht erreichbar — jeder Zugriff wäre ein
 * Programmierfehler in einer Oberflächen-Aktion und fällt hier auf.
 */
export function surfaceOnlyContext(surface: ActionSurface): ActionContext {
    const noGraph = new Proxy({}, {
        get(_target, property) {
            throw new Error(`Im Browser-Loop gibt es keinen Store (Zugriff auf "${String(property)}").`);
        },
    }) as GraphHandle;
    return {
        identity: { userId: '', authenticated: false, label: 'browser' },
        grant: { identity: 'browser', readableGraphs: [], writableGraph: null, sparql: false },
        graph: noGraph,
        surface,
    };
}

/**
 * Lokale Ausführung einer Oberflächen-Aktion (Browser-Loop): Eingabe wie
 * überall gegen das Schema prüfen, dann `run` mit der Live-Oberfläche.
 * Was eine Aktion mit anderem Ziel angeht, geht über die Route.
 */
export async function runSurfaceAction(
    action: (typeof SURFACE_ACTIONS)[number],
    args: unknown,
    surface: ActionSurface,
): Promise<{ output: unknown; signals: ReturnType<NonNullable<typeof action.signals>> }> {
    const input = parseActionInput(action, args);
    const ctx = surfaceOnlyContext(surface);
    // Beide Aktionen haben denselben Eingabetyp-Rahmen; die Unterscheidung
    // trifft der Aufrufer über `action`.
    const output = await (action as typeof viewScreen | typeof navigate).run(input as never, ctx);
    const signals = action.signals ? action.signals(output as never, input as never) : [];
    return { output, signals };
}
