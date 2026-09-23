'use client';

/**
 * Rückfluss schreibender Aktionen in die Oberfläche (ACTIONS_SPEC §5, A3).
 *
 * Nach einer schreibenden Aktion trägt der Chat-Stream ein
 * Änderungsereignis mit den `changes` der Aktion (Entitätstypen). Der
 * Client invalidiert die betroffenen Queries und sagt es den Seiten, die
 * ohne React Query laden. Kein Polling: Im selben Client ist das
 * Ereignis bekannt — fremde Schreiber (MCP-Client, Connector-Lauf) deckt
 * das bewusst nicht ab (ACTIONS_SPEC §8).
 */

import { useEffect, useRef } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { OW, SCHEMA } from '@/lib/graph/vocab';

/** DOM-Ereignis für Seiten, die per `fetch` laden (Aufgaben, Dokumente, Pinnwände). */
export const WORKSPACE_CHANGE_EVENT = 'ow:workspace-changed';

export interface WorkspaceChangeDetail {
    entityTypes: readonly string[];
}

/**
 * Welche Query-Schlüssel ein Entitätstyp berührt. Präfixe: React Query
 * invalidiert alles, was mit dem Schlüssel beginnt (`['a2ui-docs', q]`).
 * `activity` immer — jede Schreibaktion erscheint im Aktivitätslog.
 */
const QUERY_KEYS_BY_TYPE: Record<string, readonly string[][]> = {
    [OW.Task]: [['a2ui-tasks'], ['a2ui-stats']],
    [OW.Project]: [['a2ui-tasks'], ['a2ui-stats']],
    [OW.Document]: [['a2ui-docs'], ['a2ui-stats']],
    [OW.Canvas]: [['a2ui-stats']],
    [SCHEMA.Event]: [['a2ui-calendar']],
    [SCHEMA.DataFeed]: [['a2ui-calendar']],
    [OW.Skill]: [['skills'], ['graph-self-model']],
    [OW.Agent]: [['agents'], ['graph-self-model']],
    [OW.Tool]: [['tools'], ['graph-self-model']],
    [OW.ToolProvider]: [['tools'], ['mcp-server-status']],
    [OW.InferenceProvider]: [['tools']],
    [OW.Connector]: [['graph-connectors']],
    [OW.FederatedEndpoint]: [['graph-federation']],
    [OW.CausalModel]: [['graph-causal']],
    [OW.Estimand]: [['graph-causal']],
    [OW.CausalStudy]: [['graph-causal']],
    [OW.Variable]: [['graph-observations'], ['graph-causal']],
    [OW.QueryView]: [['graph-views']],
    [OW.Space]: [['graph-access']],
    [OW.OnboardingStep]: [['onboarding']],
};

/** Query-Schlüssel (Präfixe), die diese Entitätstypen berühren — dedupliziert, sortiert. */
export function queryKeysFor(entityTypes: readonly string[]): string[][] {
    const keys = new Map<string, string[]>();
    keys.set('activity', ['activity']);
    for (const type of entityTypes) {
        for (const key of QUERY_KEYS_BY_TYPE[type] ?? []) keys.set(key.join('/'), [...key]);
    }
    return [...keys.values()].sort((a, b) => a.join('/').localeCompare(b.join('/')));
}

/** Invalidiert die betroffenen Queries und benachrichtigt die fetch-basierten Seiten. */
export function applyWorkspaceChanges(
    queryClient: Pick<QueryClient, 'invalidateQueries'>,
    entityTypes: readonly string[],
    target: Pick<Window, 'dispatchEvent'> | null = typeof window === 'undefined' ? null : window,
): void {
    for (const queryKey of queryKeysFor(entityTypes)) {
        void queryClient.invalidateQueries({ queryKey });
    }
    target?.dispatchEvent(new CustomEvent<WorkspaceChangeDetail>(WORKSPACE_CHANGE_EVENT, {
        detail: { entityTypes: [...entityTypes] },
    }));
}

/**
 * Seiten ohne React Query hängen sich hier ein: `handler` läuft, sobald
 * eine schreibende Aktion einen der genannten Typen (oder bei leerer
 * Liste irgendeinen) verändert hat.
 */
export function useWorkspaceChanges(entityTypes: readonly string[], handler: () => void): void {
    const latest = useRef(handler);
    useEffect(() => {
        latest.current = handler;
    });
    const key = entityTypes.join('\n');
    useEffect(() => {
        const wanted = new Set(key === '' ? [] : key.split('\n'));
        const listener = (event: Event) => {
            const detail = (event as CustomEvent<WorkspaceChangeDetail>).detail;
            if (!detail) return;
            if (wanted.size === 0 || detail.entityTypes.some(type => wanted.has(type))) latest.current();
        };
        window.addEventListener(WORKSPACE_CHANGE_EVENT, listener);
        return () => window.removeEventListener(WORKSPACE_CHANGE_EVENT, listener);
    }, [key]);
}
