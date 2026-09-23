/**
 * Aktionen des Agenten-Moduls (ACTIONS_SPEC, A4): lokale Personas und
 * Remote-A2A-Agenten der Installation. Instanzweite Konfiguration; nach
 * jeder Änderung wird der AI-Spiegel erneuert (M9).
 */

import { z } from 'zod';
import { defineAction, notFound } from '@/lib/actions/contract';
import { registerActions } from '@/lib/actions/registry';
import { createAgentSchema, updateAgentSchema } from '@/lib/api/validation';
import { OW } from '@/lib/graph/vocab';
import { createAgent, deleteAgent, loadAgents, updateAgent } from './storage';
import type { Agent } from './types';

export const listAgents = defineAction({
    name: 'agents_list',
    title: 'Agenten auflisten',
    description: 'Listet die konfigurierten Agenten (lokale Personas und Remote-A2A-Agenten).',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'instance' },
    async run() {
        return { agents: await loadAgents() };
    },
});

export const createAgentAction = defineAction({
    name: 'agents_create',
    title: 'Agent anlegen',
    description: 'Legt einen Agenten an, an den der Assistent delegieren kann.',
    input: createAgentSchema,
    effect: 'constructive',
    target: { kind: 'instance' },
    changes: [OW.Agent],
    async run(input, ctx) {
        const agent = await createAgent(input);
        await ctx.persist?.aiMirror('Agent angelegt');
        return { agent };
    },
});

export const updateAgentAction = defineAction({
    name: 'agents_update',
    title: 'Agent ändern',
    description: 'Ändert einen Agenten (Name, Beschreibung, Konfiguration, Aktivierung).',
    input: updateAgentSchema,
    effect: 'constructive',
    target: { kind: 'instance' },
    changes: [OW.Agent],
    async run(input, ctx) {
        const { id, connectionId, ...rest } = input;
        const updates: Partial<Agent> = { ...rest };
        if (connectionId !== undefined) {
            // null explicitly clears the linked connection
            updates.connectionId = connectionId ?? undefined;
        }
        const agent = await updateAgent(id, updates);
        if (!agent) throw notFound('Agent not found');
        await ctx.persist?.aiMirror('Agent aktualisiert');
        return { agent };
    },
});

export const deleteAgentAction = defineAction({
    name: 'agents_delete',
    title: 'Agent löschen',
    description: 'Entfernt einen Agenten.',
    input: z.object({ id: z.string().min(1).max(200) }),
    effect: 'destructive',
    target: { kind: 'instance' },
    changes: [OW.Agent],
    async run(input, ctx) {
        await deleteAgent(input.id);
        await ctx.persist?.aiMirror('Agent gelöscht');
        return { success: true as const };
    },
});

registerActions('agents', [listAgents, createAgentAction, updateAgentAction, deleteAgentAction]);
