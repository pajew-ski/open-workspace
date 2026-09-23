/**
 * Aktionen des Skills-Moduls (ACTIONS_SPEC, A4): Anleitungen, die der
 * Assistent über `use_skill` lädt. Instanzweite Konfiguration; nach jeder
 * Änderung wird der AI-Spiegel erneuert (M9), damit `ow:requiresTool`
 * aus den `[[TOOL:…]]`-Markern aktuell bleibt.
 */

import { z } from 'zod';
import { defineAction, notFound } from '@/lib/actions/contract';
import { registerActions } from '@/lib/actions/registry';
import { createSkillSchema, updateSkillSchema } from '@/lib/api/validation';
import { OW } from '@/lib/graph/vocab';
import { createSkill, deleteSkill, loadSkills, updateSkill } from './store.server';

export const listSkills = defineAction({
    name: 'skills_list',
    title: 'Skills auflisten',
    description: 'Listet die Skills der Installation mit Beschreibung, Quelle und Aktivierung.',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'instance' },
    async run() {
        return { skills: await loadSkills() };
    },
});

export const createSkillAction = defineAction({
    name: 'skills_create',
    title: 'Skill anlegen',
    description: 'Legt einen Skill (Anleitung in Markdown) an.',
    input: createSkillSchema,
    effect: 'constructive',
    target: { kind: 'instance' },
    changes: [OW.Skill],
    async run(input, ctx) {
        const skill = await createSkill(input);
        await ctx.persist?.aiMirror('Skill angelegt');
        return { skill };
    },
});

export const updateSkillAction = defineAction({
    name: 'skills_update',
    title: 'Skill ändern',
    description: 'Ändert einen Skill (Inhalt, Beschreibung, Aktivierung, Immer-laden).',
    input: updateSkillSchema.extend({ id: z.string().min(1).max(200) }),
    effect: 'constructive',
    target: { kind: 'instance' },
    changes: [OW.Skill],
    async run(input, ctx) {
        const { id, ...updates } = input;
        const skill = await updateSkill(id, updates);
        if (!skill) throw notFound('Skill nicht gefunden');
        await ctx.persist?.aiMirror('Skill aktualisiert');
        return { skill };
    },
});

export const deleteSkillAction = defineAction({
    name: 'skills_delete',
    title: 'Skill löschen',
    description: 'Entfernt einen Skill.',
    input: z.object({ id: z.string().min(1).max(200) }),
    effect: 'destructive',
    target: { kind: 'instance' },
    changes: [OW.Skill],
    async run(input, ctx) {
        await deleteSkill(input.id);
        await ctx.persist?.aiMirror('Skill gelöscht');
        return { success: true as const };
    },
});

registerActions('skills', [listSkills, createSkillAction, updateSkillAction, deleteSkillAction]);
