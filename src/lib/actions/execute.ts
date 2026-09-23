/**
 * Ausführung einer Aktion — der eine Weg, den alle Adapter nehmen:
 * Eingabe prüfen (Zod), Ziel autorisieren (Grant), `run`, Signale
 * einsammeln. Route, Tool-Loop und MCP-Server unterscheiden sich nur
 * darin, wie sie Eingabe und Kontext beschaffen und das Ergebnis
 * darstellen.
 */

import { z } from 'zod';
import { authorizeTarget } from './authorize';
import { ActionError, type Action, type ActionContext, type ActionSignal } from './contract';

export interface ActionRunResult {
    output: unknown;
    signals: ActionSignal[];
    /** Aufgelöstes Ziel (Named Graph), wenn die Aktion eines hat. */
    graph: string | null;
}

function issues(error: z.ZodError): Array<{ path: string; message: string }> {
    return error.issues.map(issue => ({
        path: issue.path.map(String).join('.') || '(root)',
        message: issue.message,
    }));
}

/** Nur die Eingabe prüfen — für Adapter, die den Fehler selbst darstellen. */
export function parseActionInput(action: Action, rawInput: unknown): unknown {
    const parsed = action.input.safeParse(rawInput);
    if (!parsed.success) {
        throw new ActionError(400, 'Validierung fehlgeschlagen', issues(parsed.error));
    }
    return parsed.data;
}

export async function executeAction(action: Action, rawInput: unknown, ctx: ActionContext): Promise<ActionRunResult> {
    const input = parseActionInput(action, rawInput);
    const { graph } = await authorizeTarget(action, input, ctx);
    const output = await action.run(input, ctx);
    const signals: ActionSignal[] = [];
    if (action.effect !== 'read' && action.changes && action.changes.length > 0) {
        signals.push({ type: 'changes', entityTypes: action.changes });
    }
    if (action.signals) signals.push(...action.signals(output, input));
    return { output, signals, graph };
}
