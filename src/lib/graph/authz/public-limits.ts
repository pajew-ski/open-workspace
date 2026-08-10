/**
 * Rate-Limit anonymer Zugriffe auf den öffentlichen Teilgraphen
 * (SPEC §17.5: „Rate-Limiting und Ergebnisgrenzen für anonyme Zugriffe
 * sind Pflicht").
 *
 * Bewusst derselbe `RateLimiter` wie MCP-Server (M10) und eingehende
 * Föderation (M11) — ein gleitendes Minutenfenster, prozessweit. Ein
 * angemeldeter Nutzer zählt unter seiner Identität, ein anonymer unter
 * seiner Absenderadresse, und wenn die fehlt, unter einem gemeinsamen
 * Eimer: lieber ein zu strenges gemeinsames Limit als gar keins.
 */

import { RateLimiter } from '../mcp/limits';

const ANONYMOUS_PER_MINUTE = 60;

const globalLimiter = globalThis as unknown as { __owPublicLimiter?: RateLimiter };

function limiter(): RateLimiter {
    if (!globalLimiter.__owPublicLimiter) globalLimiter.__owPublicLimiter = new RateLimiter(Date.now);
    return globalLimiter.__owPublicLimiter;
}

/** Absender einer Anfrage hinter einem Proxy (nur fürs Limit, nie für Rechte). */
export function requestOrigin(request: Request): string {
    const forwarded = request.headers.get('x-forwarded-for');
    const first = forwarded?.split(',')[0]?.trim();
    return first || request.headers.get('x-real-ip') || 'anonym';
}

/**
 * Prüft das Limit. Rückgabe `null` = erlaubt, sonst die fertige
 * 429-Antwort mit `Retry-After`.
 */
export function publicRateLimit(
    request: Request,
    identity: string | null,
    perMinute = ANONYMOUS_PER_MINUTE,
): Response | null {
    if (identity) return null;
    const decision = limiter().check(`public:${requestOrigin(request)}`, perMinute);
    if (decision.allowed) return null;
    return new Response(
        `Rate-Limit für anonyme Zugriffe erreicht (${perMinute}/min). Erneut versuchen in ${decision.retryAfterSeconds} s.\n`,
        {
            status: 429,
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Retry-After': String(decision.retryAfterSeconds),
                'Access-Control-Allow-Origin': '*',
            },
        },
    );
}
