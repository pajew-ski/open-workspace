/**
 * Aktionen des Werkzeuge-Moduls (ACTIONS_SPEC, A4): die selbst
 * konfigurierten API-Tools. Die Tools selbst bleiben Fremdfähigkeiten im
 * Tool-Loop (Issue #34, „Nicht"); hier geht es um ihre Verwaltung.
 */

import { z } from 'zod';
import { defineAction } from '@/lib/actions/contract';
import { registerActions } from '@/lib/actions/registry';
import { createToolSchema } from '@/lib/api/validation';
import { OW } from '@/lib/graph/vocab';
import { createTool, deleteTool, loadTools } from './storage';

export const listTools = defineAction({
    name: 'tools_list',
    title: 'Werkzeuge auflisten',
    description: 'Listet die konfigurierten API-Tools.',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'instance' },
    async run() {
        return { tools: await loadTools() };
    },
});

export const createToolAction = defineAction({
    name: 'tools_create',
    title: 'Werkzeug anlegen',
    description: 'Legt ein API-Tool an (URL-/Body-Vorlage mit {Platzhaltern}).',
    input: createToolSchema,
    effect: 'constructive',
    target: { kind: 'instance' },
    changes: [OW.Tool],
    async run(input, ctx) {
        const tool = await createTool(input);
        await ctx.persist?.aiMirror('Werkzeug angelegt');
        return { tool };
    },
});

export const deleteToolAction = defineAction({
    name: 'tools_delete',
    title: 'Werkzeug löschen',
    description: 'Entfernt ein API-Tool.',
    input: z.object({ id: z.string().min(1).max(200) }),
    effect: 'destructive',
    target: { kind: 'instance' },
    changes: [OW.Tool],
    async run(input, ctx) {
        await deleteTool(input.id);
        await ctx.persist?.aiMirror('Werkzeug gelöscht');
        return { success: true as const };
    },
});

registerActions('tools', [listTools, createToolAction, deleteToolAction]);
