'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * localStorage-backed state that is safe for SSR/hydration.
 *
 * Uses useSyncExternalStore so the server snapshot (fallback) and the
 * client snapshot (stored value) are reconciled by React itself — no
 * mounted-flag, no setState-in-effect, and cross-tab changes propagate
 * via the native `storage` event.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    const onStorage = () => listener();
    if (typeof window !== 'undefined') {
        window.addEventListener('storage', onStorage);
    }
    return () => {
        listeners.delete(listener);
        if (typeof window !== 'undefined') {
            window.removeEventListener('storage', onStorage);
        }
    };
}

function emit(): void {
    for (const listener of listeners) listener();
}

export function useStoredState(
    key: string,
    fallback: string
): [string, (value: string) => void] {
    const value = useSyncExternalStore(
        subscribe,
        () => {
            try {
                return localStorage.getItem(key) ?? fallback;
            } catch {
                return fallback;
            }
        },
        () => fallback
    );

    const setValue = useCallback(
        (next: string) => {
            try {
                localStorage.setItem(key, next);
            } catch {
                // Storage may be unavailable (private mode, quota) — state
                // still updates for this session via the emit below.
            }
            emit();
        },
        [key]
    );

    return [value, setValue];
}
