/**
 * Browser-Seite des Tool-Loop-Adapters (ACTIONS_SPEC §3): dieselben
 * Definitionen wie auf dem Server (sie kommen von `GET /api/actions`),
 * ausgeführt über die Route `POST /api/actions/<name>`, weil nur dort
 * Store und Identität liegen. Ohne erreichbares Backend gibt es keine
 * Aktionen — dann erscheinen sie nicht als Werkzeug (Invariante 10),
 * statt beim Aufruf zu scheitern.
 *
 * Diese Datei ist pur: Sie bekommt `fetch` gereicht und kennt weder
 * `window` noch den Server.
 */

import type { EngineTool } from '@/lib/ai/engine';
import type { ActionSignal } from './contract';
import type { ActionToolDefinition } from './schema';
import { withSignals } from './tools';

/** Antwort von `POST /api/actions/<name>` (`route.ts#invokeResponse`). */
export interface ActionInvokeResponse {
    output?: unknown;
    signals?: ActionSignal[];
    error?: string;
    details?: unknown;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Definitionen des Aufrufers vom Server holen; `[]` ohne Backend. */
export async function fetchActionDefinitions(fetchImpl: FetchLike): Promise<ActionToolDefinition[]> {
    try {
        const response = await fetchImpl('/api/actions', { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
        if (!response.ok) return [];
        const data = await response.json() as { actions?: ActionToolDefinition[] };
        return Array.isArray(data.actions) ? data.actions : [];
    } catch {
        return [];
    }
}

function describeError(data: ActionInvokeResponse, status: number): string {
    const details = data.details === undefined
        ? ''
        : ` (${typeof data.details === 'string' ? data.details : JSON.stringify(data.details)})`;
    return `Fehler: ${data.error ?? `HTTP ${status}`}${details}`;
}

/**
 * Engine-Tools aus Definitionen. Die Ausführung läuft über die Route —
 * Validierung, Autorisierung und SHACL liegen dort; hier wird nur
 * durchgereicht und der Fehler wörtlich weitergegeben, damit das Modell
 * die Ursache sieht statt eines Statuscodes.
 */
export function engineToolsFromDefinitions(
    definitions: readonly ActionToolDefinition[],
    fetchImpl: FetchLike,
): EngineTool[] {
    return definitions.map(definition => ({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
        source: 'builtin',
        execute: async args => {
            try {
                const response = await fetchImpl(`/api/actions/${encodeURIComponent(definition.name)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(args),
                    signal: AbortSignal.timeout(60_000),
                });
                const data = (await response.json().catch(() => ({}))) as ActionInvokeResponse;
                if (!response.ok || data.error) return { text: describeError(data, response.status) };
                const text = typeof data.output === 'string'
                    ? data.output
                    : data.output === undefined || data.output === null ? 'OK' : JSON.stringify(data.output);
                return withSignals(text, data.signals ?? []);
            } catch (error) {
                return { text: `Fehler bei der Ausführung: ${error instanceof Error ? error.message : 'unbekannt'}` };
            }
        },
    }));
}
