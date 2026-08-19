/**
 * Die schreibenden Workspace-Tools im Tool-Loop (Ablösung der
 * CopilotKit-Actions, ANALYSE §5 P0.3).
 *
 * Geprüft wird die Grenze zwischen Sprachmodell und Workspace: Was das
 * Modell an Argumenten liefert, ist Behauptung — das Tool nimmt nur
 * gesetzte Felder an, verlangt die Pflichtangabe und meldet einen Fehler
 * als Text zurück (der Tool-Loop lebt weiter, statt den Turn abzubrechen).
 * Der Schreibweg selbst liegt bewusst NICHT hier: Er ist je Laufzeit
 * verschieden (Storage-Fassade auf dem Server, Route im Browser) und wird
 * über die Route bzw. die Store-Tests abgedeckt.
 */

import { describe, expect, it } from 'vitest';
import {
    CREATE_TASK_TOOL_NAME,
    UPDATE_TASK_TOOL_NAME,
    makeCreateTaskTool,
    makeUpdateTaskTool,
    toPromptInfo,
    type TaskToolFields,
} from '@/lib/ai/tools.shared';

describe('workspace_create_task', () => {
    it('reicht nur gesetzte Felder durch und meldet den Erfolg im Klartext', async () => {
        const seen: TaskToolFields[] = [];
        const tool = makeCreateTaskTool(async fields => {
            seen.push(fields);
            return 'Aufgabe "Dach decken" angelegt (ID t-1, Status todo, Priorität high).';
        });

        expect(tool.name).toBe(CREATE_TASK_TOOL_NAME);
        expect(tool.source).toBe('builtin');

        const result = await tool.execute({ title: 'Dach decken', priority: 'high', description: '' });
        expect(seen).toEqual([{ title: 'Dach decken', priority: 'high' }]);
        expect(result.text).toContain('angelegt');
    });

    it('verlangt den Titel, statt einen zu erfinden', async () => {
        let called = false;
        const tool = makeCreateTaskTool(async () => { called = true; return 'nie'; });

        expect((await tool.execute({})).text).toMatch(/Fehler.*title/);
        expect((await tool.execute({ title: '   ' })).text).toMatch(/Fehler.*title/);
        expect(called).toBe(false);
    });

    it('nimmt keine Felder an, die nicht zum Vertrag gehören', async () => {
        const seen: TaskToolFields[] = [];
        const tool = makeCreateTaskTool(async fields => { seen.push(fields); return 'ok'; });

        await tool.execute({ title: 'A', id: 'fremd', actualEffort: 12, tags: ['x'] });
        expect(seen).toEqual([{ title: 'A' }]);

        const schema = tool.parameters as { additionalProperties?: boolean; required?: string[] };
        expect(schema.additionalProperties).toBe(false);
        expect(schema.required).toEqual(['title']);
    });
});

describe('workspace_update_task', () => {
    it('braucht die ID und mindestens ein Feld', async () => {
        let called = false;
        const tool = makeUpdateTaskTool(async () => { called = true; return 'nie'; });

        expect(tool.name).toBe(UPDATE_TASK_TOOL_NAME);
        expect((await tool.execute({ status: 'done' })).text).toMatch(/Fehler.*taskId/);
        expect((await tool.execute({ taskId: 't-1' })).text).toMatch(/Fehler.*kein zu änderndes Feld/);
        expect(called).toBe(false);
    });

    it('trennt ID und Änderung sauber', async () => {
        const calls: Array<[string, TaskToolFields]> = [];
        const tool = makeUpdateTaskTool(async (id, fields) => { calls.push([id, fields]); return 'ok'; });

        await tool.execute({ taskId: '  t-7  ', status: 'done', title: 'Neu' });
        expect(calls).toEqual([['t-7', { status: 'done', title: 'Neu' }]]);
    });

    it('nennt den Finder als Herkunft der ID — das Modell soll sie nicht raten', () => {
        const tool = makeUpdateTaskTool(async () => 'ok');
        expect(tool.description).toContain('workspace_finder');
    });
});

describe('Prompt-Dokumentation der neuen Builtins', () => {
    it('führt beide Tools mit ihren Argumenten als builtin', () => {
        const create = toPromptInfo(makeCreateTaskTool(async () => 'ok'));
        expect(create.source).toBe('builtin');
        expect(create.argsHint).toContain('"title":…');
        expect(create.argsHint).toContain('"priority":…?');

        const update = toPromptInfo(makeUpdateTaskTool(async () => 'ok'));
        expect(update.argsHint).toContain('"taskId":…');
    });
});
