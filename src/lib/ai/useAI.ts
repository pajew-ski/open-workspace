'use client';

import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useStoredState } from '@/lib/hooks/useStoredState';
import { useSyncExternalStore } from 'react';
import { getBackendSnapshot, subscribeBackend, checkBackend } from '@/lib/platform/backend';
import { loadClientAIState, resolveRoute, type ClientAIState, type ClientProviderRecord, type ResolvedRoute } from './store.client';

/**
 * React hooks over the AI client gateway: merged provider state,
 * per-provider route/health, and the globally active provider/model
 * selection used by the chat surfaces.
 */

export const AI_STATE_QUERY_KEY = ['ai-state'];

export function useAIState() {
    return useQuery<ClientAIState>({
        queryKey: AI_STATE_QUERY_KEY,
        queryFn: loadClientAIState,
        staleTime: 15_000,
        refetchOnWindowFocus: false,
    });
}

export function useInvalidateAIState() {
    const queryClient = useQueryClient();
    return useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: AI_STATE_QUERY_KEY });
    }, [queryClient]);
}

/** Live backend availability (unknown until the first probe resolves). */
export function useBackendAvailability() {
    const availability = useSyncExternalStore(subscribeBackend, getBackendSnapshot, () => 'unknown' as const);
    // Kick off the initial probe lazily.
    if (typeof window !== 'undefined' && availability === 'unknown') {
        void checkBackend();
    }
    return availability;
}

/** Route decision + probe for one provider (cached ~1 min in the gateway). */
export function useProviderRoute(record: ClientProviderRecord | undefined, enabled = true) {
    return useQuery<ResolvedRoute>({
        queryKey: ['ai-route', record?.id, record?.baseUrl, record?.connectionMode, record?.keyLocation],
        queryFn: () => resolveRoute(record!),
        enabled: Boolean(record) && enabled,
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: false,
    });
}

const SELECTION_KEY = 'ow.ai.selection';

export interface ActiveSelection {
    providerId?: string;
    model?: string;
}

/**
 * The active provider/model for chat. Falls back to the configured
 * defaults, then to the first enabled provider.
 */
export function useActiveSelection(state: ClientAIState | undefined) {
    const [raw, setRaw] = useStoredState(SELECTION_KEY, '');

    const stored: ActiveSelection = useMemo(() => {
        try {
            const parsed = raw ? JSON.parse(raw) : {};
            return typeof parsed === 'object' && parsed !== null ? parsed : {};
        } catch {
            return {};
        }
    }, [raw]);

    const active = useMemo(() => {
        const providers = state?.providers.filter(p => p.enabled) ?? [];
        const byId = (id?: string) => providers.find(p => p.id === id);
        const provider = byId(stored.providerId) ?? byId(state?.defaults.providerId) ?? providers[0];
        const model = (provider && stored.providerId === provider.id && stored.model)
            ? stored.model
            : (provider && state?.defaults.providerId === provider.id && state.defaults.model)
                ? state.defaults.model
                : provider?.defaultModel ?? provider?.pinnedModels?.[0];
        return { provider, model };
    }, [state, stored]);

    const setSelection = useCallback((providerId: string, model?: string) => {
        setRaw(JSON.stringify({ providerId, model }));
    }, [setRaw]);

    return { ...active, setSelection };
}
