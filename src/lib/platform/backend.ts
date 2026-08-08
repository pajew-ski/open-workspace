'use client';

/**
 * Backend availability detection.
 *
 * The workspace treats its own Next.js backend as OPTIONAL: every
 * AI-platform feature has a browser-only path. This module answers the
 * one question the client gateway needs — "is a workspace backend
 * reachable right now?" — cheaply, cached, and observable.
 *
 * Serverless deployments (static hosting, backend down, offline PWA)
 * simply answer "unavailable" and the app keeps working on the browser
 * paths (localStorage/IndexedDB + direct inference connections).
 */

export type BackendAvailability = 'unknown' | 'available' | 'unavailable';

interface BackendState {
    availability: BackendAvailability;
    checkedAt: number;
}

const CHECK_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_500;

let state: BackendState = { availability: 'unknown', checkedAt: 0 };
let inflight: Promise<BackendAvailability> | null = null;
const listeners = new Set<() => void>();

function setState(availability: BackendAvailability): void {
    const changed = state.availability !== availability;
    state = { availability, checkedAt: Date.now() };
    if (changed) listeners.forEach(listener => listener());
}

async function probe(): Promise<BackendAvailability> {
    try {
        const response = await fetch('/api/ai/config', {
            method: 'GET',
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
            // The service worker caches GET /api/* — bypass it here, we want
            // the truth about the live backend, not a cached copy.
            cache: 'no-store',
        });
        // Static hosts answer 404/HTML for unknown paths — only a JSON 200 counts.
        if (!response.ok) return 'unavailable';
        const contentType = response.headers.get('content-type') ?? '';
        return contentType.includes('application/json') ? 'available' : 'unavailable';
    } catch {
        return 'unavailable';
    }
}

/** Cached backend availability (probes at most every 30s). */
export async function checkBackend(force = false): Promise<BackendAvailability> {
    if (typeof window === 'undefined') return 'available'; // on the server, the backend is us
    if (!force && state.availability !== 'unknown' && Date.now() - state.checkedAt < CHECK_TTL_MS) {
        return state.availability;
    }
    if (!inflight) {
        inflight = probe().then(result => {
            setState(result);
            inflight = null;
            return result;
        });
    }
    return inflight;
}

/** Synchronous snapshot (may be 'unknown' before the first probe). */
export function getBackendSnapshot(): BackendAvailability {
    return state.availability;
}

export function subscribeBackend(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

// Re-probe when connectivity returns.
if (typeof window !== 'undefined') {
    window.addEventListener('online', () => { void checkBackend(true); });
}
