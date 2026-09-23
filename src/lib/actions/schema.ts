/**
 * JSON-Schema aus dem Zod-Schema einer Aktion (ACTIONS_SPEC §2): Das ist
 * die EINE Ableitung, die Function Calling, MCP und der Tool-Knoten im
 * Selbstmodell bekommen. Handgeschriebene Schemas neben dem Zod-Schema
 * gibt es im Tool-Pfad nicht mehr — das prüft `tests/ai/actions.test.ts`.
 */

import { z } from 'zod';
import type { Action } from './contract';

/** Tool-Definition, wie beide Tool-Loops und der Browser sie sehen. */
export interface ActionToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    effect: Action['effect'];
}

/**
 * Zod 4 erzeugt Draft 2020-12; `io: 'input'` beschreibt, was der
 * Aufrufer LIEFERN darf (Defaults optional), nicht das geparste Ergebnis.
 * `$schema` wandert nicht mit — Provider erwarten ein nacktes Objekt.
 */
export function inputJsonSchema(action: Pick<Action, 'input'>): Record<string, unknown> {
    const generated = z.toJSONSchema(action.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
    const { $schema: _dropped, ...schema } = generated;
    void _dropped;
    if (schema.type === undefined && !('anyOf' in schema) && !('oneOf' in schema)) {
        // Ein Schema ohne Typ (z. B. `z.object({}).optional()`) wäre für
        // Function Calling unbrauchbar — Objekt ist die einzige Form, die
        // Provider als Argumente akzeptieren.
        return { type: 'object', properties: {}, additionalProperties: true, ...schema };
    }
    return schema;
}

export function toolDefinition(action: Action): ActionToolDefinition {
    return {
        name: action.name,
        description: action.description,
        parameters: inputJsonSchema(action),
        effect: action.effect,
    };
}

/** Zod-Fehler als Text, den ein Modell oder ein Mensch lesen kann. */
export function formatInputIssues(error: z.ZodError): string {
    return error.issues
        .map(issue => `${issue.path.map(String).join('.') || 'Eingabe'}: ${issue.message}`)
        .join('; ');
}
