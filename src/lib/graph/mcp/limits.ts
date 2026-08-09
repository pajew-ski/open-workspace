/**
 * Rate-Limits und Timeouts des MCP-Servers (SPEC §7.6: „Rate-Limits und
 * Timeouts sind Pflicht").
 *
 * Bewusst klein und prozesslokal: ein gleitendes Fenster pro Token, keine
 * externe Abhängigkeit. Die Uhr ist injizierbar, damit die Abnahme das
 * Verhalten prüft, ohne zu warten.
 */

export interface RateLimitDecision {
    allowed: boolean;
    /** Verbleibende Anfragen im laufenden Fenster. */
    remaining: number;
    /** Sekunden bis zum Freiwerden (nur bei allowed = false). */
    retryAfterSeconds: number;
}

const WINDOW_MS = 60_000;

export class RateLimiter {
    private readonly hits = new Map<string, number[]>();

    constructor(private readonly now: () => number = Date.now) { }

    check(key: string, limitPerMinute: number): RateLimitDecision {
        const current = this.now();
        const cutoff = current - WINDOW_MS;
        const recent = (this.hits.get(key) ?? []).filter(t => t > cutoff);
        if (recent.length >= limitPerMinute) {
            this.hits.set(key, recent);
            const oldest = recent[0];
            return {
                allowed: false,
                remaining: 0,
                retryAfterSeconds: Math.max(1, Math.ceil((oldest + WINDOW_MS - current) / 1000)),
            };
        }
        recent.push(current);
        this.hits.set(key, recent);
        return { allowed: true, remaining: limitPerMinute - recent.length, retryAfterSeconds: 0 };
    }

    /** Entfernt Fenster, die vollständig abgelaufen sind (Speicherhygiene). */
    prune(): void {
        const cutoff = this.now() - WINDOW_MS;
        for (const [key, times] of this.hits) {
            const recent = times.filter(t => t > cutoff);
            if (recent.length === 0) this.hits.delete(key);
            else this.hits.set(key, recent);
        }
    }
}

export class McpTimeoutError extends Error {
    constructor(readonly operation: string, readonly timeoutMs: number) {
        super(`Zeitlimit überschritten: "${operation}" wurde nach ${timeoutMs} ms abgebrochen.`);
        this.name = 'McpTimeoutError';
    }
}

/**
 * Kappt eine Operation zeitlich. Ehrliche Grenze: Oxigraph-WASM arbeitet
 * synchron und ist nicht unterbrechbar (siehe QueryOptions.timeoutMs) —
 * dieses Limit beendet das Warten des Aufrufers, nicht zwingend die
 * laufende Query. Die harte Kappung liefert erst der Worker-/Prozess-Store.
 */
export async function withTimeout<T>(operation: string, timeoutMs: number, run: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            run(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new McpTimeoutError(operation, timeoutMs)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Zeitbudget je Werkzeug (ms) — großzügig, aber endlich. */
export const MCP_TOOL_TIMEOUT_MS = {
    graph_search: 10_000,
    graph_retrieve: 20_000,
    graph_neighbors: 10_000,
    graph_describe: 10_000,
    graph_sparql: 30_000,
    graph_write: 20_000,
    resource: 10_000,
} as const;
