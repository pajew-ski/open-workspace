/**
 * Route-Adapter (ACTIONS_SPEC §3): Eine Route ist ein dünner Adapter —
 * Eingabe aus der HTTP-Form holen (Pfad, Query, Body), `ctx` aus der
 * Anfrage-Authentifizierung, `run`, Fehler auf Status abbilden. Was eine
 * Route darüber hinaus enthält, ist ein Verstoß, den
 * `tests/platform/action-parity.test.ts` sichtbar macht.
 *
 * Serverseitig (Next.js), deshalb getrennt von `tools.ts`.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ShaclViolationError } from '@/lib/graph/reasoning/shacl';
import { ActionError, type Action, type ActionSurface } from './contract';
import { executeAction, type ActionRunResult } from './execute';
import { actionContextFromRequest } from './context.server';

export interface RespondOptions {
    /** HTTP-Status im Erfolgsfall (Default 200; 201 für Anlegen). */
    status?: number;
    /** Form der Antwort — Default: das Ergebnis der Aktion selbst. */
    shape?: (output: unknown, result: ActionRunResult) => unknown;
    /** Status je Ergebnis (z. B. 502, wenn ein Lauf durchgehend scheiterte). */
    statusFor?: (output: unknown) => number;
    surface?: ActionSurface;
    origin?: string;
}

/**
 * JSON-Body einer Anfrage; ein leerer Body ist `{}` (Aktionen ohne
 * Pflichtfelder), ein unlesbarer ein 400.
 */
export async function readJsonBody(request: Request): Promise<unknown> {
    const raw = await request.text();
    if (raw.trim() === '') return {};
    try {
        return JSON.parse(raw) as unknown;
    } catch {
        throw new ActionError(400, 'Ungültiger JSON-Body', []);
    }
}

/** Fehler → HTTP-Antwort. Exportiert für Routen, die vor der Aktion scheitern. */
export function actionErrorResponse(error: unknown, context = 'Aktion'): NextResponse {
    if (error instanceof ActionError) {
        return NextResponse.json(
            { error: error.message, ...(error.details !== undefined ? { details: error.details } : {}) },
            { status: error.status },
        );
    }
    if (error instanceof ShaclViolationError) {
        return NextResponse.json(
            {
                error: 'Änderung verletzt die Datenqualitäts-Regeln (SHACL)',
                details: error.message,
                violations: error.violations,
            },
            { status: 422 },
        );
    }
    if (error instanceof z.ZodError) {
        return NextResponse.json({ error: 'Validierung fehlgeschlagen', details: z.prettifyError(error) }, { status: 400 });
    }
    console.error(`${context} fehlgeschlagen:`, error);
    return NextResponse.json(
        { error: `${context} fehlgeschlagen`, details: error instanceof Error ? error.message : 'unknown' },
        { status: 500 },
    );
}

/** Der Adapter: Eingabe → Aktion → Antwort. */
export async function respondWithAction(action: Action, input: unknown, options: RespondOptions = {}): Promise<NextResponse> {
    try {
        const ctx = await actionContextFromRequest({ surface: options.surface, origin: options.origin });
        const result = await executeAction(action, input, ctx);
        const body = options.shape ? options.shape(result.output, result) : result.output;
        const status = options.statusFor ? options.statusFor(result.output) : options.status ?? 200;
        return NextResponse.json(body ?? null, { status });
    } catch (error) {
        return actionErrorResponse(error, action.name);
    }
}

/**
 * Antwort des generischen Aufrufs `POST /api/actions/<name>` für den
 * Browser-Loop: Ergebnis plus Signale (`browser.ts#ActionInvokeResponse`).
 */
export async function respondWithActionInvocation(action: Action, input: unknown, options: RespondOptions = {}): Promise<NextResponse> {
    return respondWithAction(action, input, {
        ...options,
        shape: (output, result) => ({ output, signals: result.signals }),
    });
}
