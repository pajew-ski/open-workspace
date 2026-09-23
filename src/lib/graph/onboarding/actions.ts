/**
 * Aktionen der Einführungsstrecke (ACTIONS_SPEC, A4; GRAPH_CORE_SPEC §18,
 * M14): Zustand, Schritt ausführen, Schritt zurücknehmen. Was dabei
 * entsteht, entsteht auf den regulären Pfaden (Store-first-CRUD,
 * Connector-Vertrag); die Aufzeichnung (`ow:OnboardingStep`) liegt in
 * graph/meta unter der Nutzer-IRI — ein Registry-Eintrag.
 *
 * Der Abhängigkeits-Satz kommt vollständig aus dem Aktionskontext:
 * Handle, Workspace-CRUD, Dateibaum und Runtime für den Sync-Runner, der
 * Grant als Verengung des Datasets, Snapshot und Inferenz-Lauf.
 */

import { z } from 'zod';
import { ActionError, defineAction, type ActionContext } from '@/lib/actions/contract';
import { registerActions } from '@/lib/actions/registry';
import { OW } from '../vocab';
import { onboardingState, OnboardingError, performOnboardingStep, undoOnboardingStep, type OnboardingDeps } from './run';
import { ONBOARDING_STEP_IDS } from './steps';

async function depsOf(ctx: ActionContext): Promise<OnboardingDeps> {
    return {
        handle: ctx.graph,
        workspace: await ctx.workspace!(),
        authz: { allowedGraphs: ctx.grant.readableGraphs },
        ...(ctx.platform ? { sync: { files: ctx.platform.files, runtime: ctx.platform.runtime } } : {}),
        ...(ctx.persist ? {
            persist: async () => { await ctx.persist!.snapshot(); },
            reason: async () => { await ctx.persist!.reasoning(); },
        } : {}),
    };
}

/** Ein abgelehnter Schritt (Voraussetzung fehlt, Schritt nicht rückgängig) ist 422, kein Serverfehler. */
function rethrow(error: unknown): never {
    if (error instanceof OnboardingError) throw new ActionError(422, error.message);
    throw error;
}

const stepSchema = z.object({ step: z.enum(ONBOARDING_STEP_IDS) });

export const onboardingStateAction = defineAction({
    name: 'onboarding_state',
    title: 'Einführung: Zustand',
    description: 'Die Schritte der Einführungsstrecke, ihr aufgezeichneter Fortschritt und die Live-Daten dazu (Selbstmodell, Herkunft).',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'registry' },
    requires: ['workspace'],
    async run(_input, ctx) {
        return onboardingState(await depsOf(ctx));
    },
});

export const performStepAction = defineAction({
    name: 'onboarding_perform_step',
    title: 'Einführung: Schritt ausführen',
    description: 'Führt einen Schritt der Einführungsstrecke aus (z. B. Beispieldaten importieren, eigenen Knoten anlegen).',
    input: stepSchema,
    effect: 'constructive',
    target: { kind: 'registry' },
    requires: ['workspace', 'platform'],
    changes: [OW.OnboardingStep],
    async run(input, ctx) {
        try {
            return await performOnboardingStep(await depsOf(ctx), input.step);
        } catch (error) {
            return rethrow(error);
        }
    },
});

export const undoStepAction = defineAction({
    name: 'onboarding_undo_step',
    title: 'Einführung: Schritt zurücknehmen',
    description: 'Nimmt einen ausgeführten Schritt der Einführungsstrecke zurück: erst das Erzeugte, dann die Aufzeichnung.',
    input: stepSchema,
    effect: 'destructive',
    target: { kind: 'registry' },
    requires: ['workspace', 'platform'],
    changes: [OW.OnboardingStep],
    async run(input, ctx) {
        try {
            return await undoOnboardingStep(await depsOf(ctx), input.step);
        } catch (error) {
            return rethrow(error);
        }
    },
});

registerActions('graph/onboarding', [onboardingStateAction, performStepAction, undoStepAction]);
