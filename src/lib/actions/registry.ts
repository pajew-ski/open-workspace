/**
 * Die Registry (ACTIONS_SPEC §2): der eine Ort, an dem alle Aktionen
 * bekannt sind. Die Aktionen selbst liegen bei den Modulen, denen sie
 * gehören (`src/lib/<modul>/actions.ts`), und registrieren sich hier —
 * eine zentrale Handliste wäre dieselbe Drift an neuem Ort.
 *
 * Wer die Module lädt, steht in `catalog.ts`; dass dort keines fehlt,
 * prüft `tests/platform/action-parity.test.ts`.
 *
 * Prozessweit über `globalThis`, wie die Store-Instanz: Next.js erzeugt
 * Module im Dev-Modus mehrfach, und zwei Registries wüssten nichts
 * voneinander.
 */

import { ActionContractError, type Action, type ActionEffect } from './contract';

interface RegistryState {
    actions: Map<string, { action: Action; module: string }>;
}

const globalState = globalThis as unknown as { __owActionRegistry?: RegistryState };

function state(): RegistryState {
    if (!globalState.__owActionRegistry) {
        globalState.__owActionRegistry = { actions: new Map() };
    }
    return globalState.__owActionRegistry;
}

/**
 * Registriert die Aktionen eines Moduls. `module` ist die Herkunft (der
 * Modulpfad) — dieselbe Herkunft darf sich beim Hot-Reload neu
 * registrieren, ein zweites Modul mit demselben Aktionsnamen ist ein
 * Vertragsfehler.
 */
export function registerActions(module: string, actions: readonly Action[]): void {
    const registry = state();
    for (const action of actions) {
        const existing = registry.actions.get(action.name);
        if (existing && existing.module !== module) {
            throw new ActionContractError(
                `Aktion "${action.name}" ist doppelt definiert: ${existing.module} und ${module}.`,
            );
        }
        registry.actions.set(action.name, { action, module });
    }
}

/** Alle Aktionen, nach Namen sortiert (deterministisch für Spiegel und Tests). */
export function listActions(): Action[] {
    return [...state().actions.values()]
        .map(entry => entry.action)
        .sort((a, b) => a.name.localeCompare(b.name));
}

export function getAction(name: string): Action | null {
    return state().actions.get(name)?.action ?? null;
}

/** Herkunftsmodul einer Aktion (Paritätstest). */
export function actionModule(name: string): string | null {
    return state().actions.get(name)?.module ?? null;
}

export function actionsWithEffect(effects: readonly ActionEffect[]): Action[] {
    return listActions().filter(action => effects.includes(action.effect));
}

/** Nur für Tests: Registry leeren. */
export function __resetActionRegistryForTests(): void {
    delete globalState.__owActionRegistry;
}
