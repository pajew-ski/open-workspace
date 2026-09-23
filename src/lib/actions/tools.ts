/**
 * Tool-Loop-Adapter (ACTIONS_SPEC §3): Aus der Registry werden die
 * Tool-Definitionen für das Sprachmodell abgeleitet und — auf dem
 * Server — im Prozess mit dem Kontext des Chat-Requests ausgeführt.
 *
 * Der Browser-Loop bekommt DIESELBEN Definitionen über
 * `GET /api/actions` und führt über `POST /api/actions/<name>` aus
 * (`browser.ts`); dass beide Wege identische Definitionen liefern, prüft
 * `tests/ai/actions.test.ts`. Kein `if (isBrowser)`: Diese Datei kennt
 * keine Laufzeit, nur Kontexte.
 *
 * Sichtbar sind `read` und `constructive`. `destructive` erscheint auf
 * keiner Agenten-Oberfläche — die Regel „gelöscht wird über kein Tool"
 * wird hier vom Vertrag erzwungen, nicht vom Weglassen.
 */

import type { EngineTool, EngineToolResult } from '@/lib/ai/engine';
import { availability } from './authorize';
import { ActionError, type Action, type ActionContext, type ActionEffect, type ActionSignal } from './contract';
import { executeAction } from './execute';
import { listActions } from './registry';
import { toolDefinition, type ActionToolDefinition } from './schema';

/** Effektklassen, die ein Agent sieht (Tool-Loops, MCP per Default nur `read`). */
export const AGENT_VISIBLE_EFFECTS: readonly ActionEffect[] = ['read', 'constructive'];

/** Aktionen, die dieser Kontext als Werkzeug bekommt. */
export async function visibleActions(
    ctx: ActionContext,
    effects: readonly ActionEffect[] = AGENT_VISIBLE_EFFECTS,
): Promise<Action[]> {
    const visible: Action[] = [];
    for (const action of listActions()) {
        if (!effects.includes(action.effect)) continue;
        if ((await availability(action, ctx)).available) visible.push(action);
    }
    return visible;
}

/** Tool-Definitionen des Kontexts — was `GET /api/actions` liefert. */
export async function visibleToolDefinitions(ctx: ActionContext): Promise<ActionToolDefinition[]> {
    return (await visibleActions(ctx)).map(toolDefinition);
}

/**
 * Ergebnis als Text für das Modell. Strings bleiben, alles andere wird
 * JSON; die Kappung auf das Kontextfenster macht die Engine
 * (`MAX_TOOL_RESULT_CHARS`), und Listen-Aktionen tragen ein `limit`.
 */
export function formatActionOutput(output: unknown): string {
    if (typeof output === 'string') return output;
    if (output === undefined || output === null) return 'OK';
    return JSON.stringify(output);
}

/** Fehlertext für das Modell — der Tool-Loop lebt weiter, statt den Turn abzubrechen. */
export function formatActionError(error: unknown): string {
    if (error instanceof ActionError) {
        const details = error.details === undefined
            ? ''
            : ` (${typeof error.details === 'string' ? error.details : JSON.stringify(error.details)})`;
        return `Fehler: ${error.message}${details}`;
    }
    return `Fehler: ${error instanceof Error ? error.message : 'unbekannt'}`;
}

/** Signale einer Ausführung an das Ergebnis des Engine-Tools hängen. */
export function withSignals(text: string, signals: ActionSignal[]): EngineToolResult {
    return signals.length > 0 ? { text, signals } : { text };
}

/**
 * Engine-Tool einer Aktion, das IM PROZESS mit dem gegebenen Kontext
 * läuft (Server-Loop). Die Parameter sind das aus dem Zod-Schema erzeugte
 * JSON-Schema — es gibt keine zweite Beschreibung.
 */
export function actionEngineTool(action: Action, ctx: ActionContext): EngineTool {
    const definition = toolDefinition(action);
    return {
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
        source: 'builtin',
        execute: async args => {
            try {
                const result = await executeAction(action, args, ctx);
                return withSignals(formatActionOutput(result.output), result.signals);
            } catch (error) {
                return { text: formatActionError(error) };
            }
        },
    };
}

export async function actionEngineTools(ctx: ActionContext): Promise<EngineTool[]> {
    return (await visibleActions(ctx)).map(action => actionEngineTool(action, ctx));
}
