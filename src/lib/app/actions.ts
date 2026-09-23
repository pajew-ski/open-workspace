/**
 * Aktionen der Anwendung selbst (ACTIONS_SPEC, A4): Einstellungen,
 * Dashboard-Layout, Kennzahlen, Aktivitätslog. Alles instanzweit außer
 * den Kennzahlen, die aus dem Workspace des Aufrufers zählen.
 */

import path from 'node:path';
import { z } from 'zod';
import { defineAction } from '@/lib/actions/contract';
import { registerActions } from '@/lib/actions/registry';
import { getActivities } from '@/lib/activity';
import { loadSettings, saveSettings } from '@/lib/settings';
import { readJsonSafe, withFileLock, writeJsonAtomic } from '@/lib/storage/atomic';
import * as crud from '@/lib/graph/workspace/crud';
import { SCHEMA } from '@/lib/graph/vocab';

const DASHBOARD_FILE = () => path.join(process.cwd(), 'data', 'dashboard.json');

export const dashboardWidgetSchema = z.object({
    id: z.string().min(1).max(200),
    type: z.enum(['welcome', 'stats', 'activity', 'image', 'quick-access']),
    order: z.number().int().min(0).max(10_000),
    content: z.string().max(50_000).optional(),
    url: z.string().max(2048).optional(),
    title: z.string().max(300).optional(),
});

export const dashboardLayoutSchema = z.object({
    layout: z.array(dashboardWidgetSchema).max(100),
});

type DashboardData = z.output<typeof dashboardLayoutSchema>;

const DEFAULT_DASHBOARD: DashboardData = {
    layout: [
        { id: 'welcome-1', type: 'welcome', content: '<h2>Willkommen im Open Workspace</h2><p>Dein zentraler Arbeitsbereich für AI-gestützte Produktivität.</p>', order: 0 },
        { id: 'stats-1', type: 'stats', order: 1 },
        { id: 'activity-1', type: 'activity', title: 'Letzte Aktivitäten', order: 2 },
    ],
};

export const getSettings = defineAction({
    name: 'settings_get',
    title: 'Einstellungen lesen',
    description: 'Liest die instanzweiten Einstellungen (Inferenz-Endpunkt und Modell der Altkonfiguration).',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'instance' },
    async run() {
        return { settings: await loadSettings() };
    },
});

export const updateSettings = defineAction({
    name: 'settings_update',
    title: 'Einstellungen ändern',
    description: 'Ändert die instanzweiten Einstellungen.',
    input: z.object({
        inference: z
            .object({
                endpoint: z.string().url().max(500).or(z.literal('')),
                model: z.string().max(200),
            })
            .partial()
            .optional(),
    }),
    effect: 'constructive',
    target: { kind: 'instance' },
    changes: [SCHEMA.SoftwareApplication],
    async run(input) {
        return { settings: await saveSettings({ inference: input.inference }) };
    },
});

export const getDashboardLayout = defineAction({
    name: 'dashboard_get_layout',
    title: 'Dashboard-Layout lesen',
    description: 'Liest die Widgets der Übersichtsseite in ihrer Reihenfolge.',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'instance' },
    async run() {
        // Fehlende oder defekte Datei fällt auf das Standard-Layout zurück.
        return readJsonSafe<DashboardData>(DASHBOARD_FILE(), DEFAULT_DASHBOARD);
    },
});

export const saveDashboardLayout = defineAction({
    name: 'dashboard_save_layout',
    title: 'Dashboard-Layout speichern',
    description: 'Speichert die Widgets der Übersichtsseite (nur bekannte Typen und Felder).',
    input: dashboardLayoutSchema,
    effect: 'constructive',
    target: { kind: 'instance' },
    changes: [SCHEMA.SoftwareApplication],
    async run(input) {
        await withFileLock(DASHBOARD_FILE(), async () => {
            await writeJsonAtomic(DASHBOARD_FILE(), { layout: input.layout });
        });
        return { success: true as const };
    },
});

export const dashboardStats = defineAction({
    name: 'dashboard_stats',
    title: 'Kennzahlen',
    description: 'Zählt Dokumente, Aufgaben und Pinnwände des Workspace.',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'graph', scope: 'workspace' },
    requires: ['workspace'],
    async run(_input, ctx) {
        const workspace = await ctx.workspace!();
        const [docs, tasks, canvases] = await Promise.all([
            crud.listDocs(workspace),
            crud.listTasks(workspace),
            crud.listCanvases(workspace),
        ]);
        return { stats: { docs: docs.length, tasks: tasks.length, canvases: canvases.length } };
    },
});

export const listActivity = defineAction({
    name: 'activity_list',
    title: 'Aktivitätslog',
    description: 'Listet die letzten Aktivitäten der Installation (angelegt, geändert, gelöscht).',
    input: z.object({
        limit: z.number().int().min(1).max(100).optional().describe('Anzahl (Default 20)'),
    }),
    effect: 'read',
    target: { kind: 'instance' },
    async run(input) {
        return { activities: await getActivities(input.limit ?? 20) };
    },
});

registerActions('app', [getSettings, updateSettings, getDashboardLayout, saveDashboardLayout, dashboardStats, listActivity]);
