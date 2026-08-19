/**
 * Rate-Limit des Chat-Endpunkts (ANALYSE §5 P2.11, TODO „Sicherheit &
 * Datenqualität").
 *
 * Der Chat war zuletzt die einzige schreibende Route ohne Limit — und die
 * teuerste: Ein Turn zieht einen Inferenz-Aufruf nach sich, der Tool-Loop
 * bis zu vier davon, dazu jedes Werkzeug, das dabei läuft. Ohne Grenze
 * genügt eine hängende Schleife im Client, um die Quote eines
 * Cloud-Providers zu verbrennen oder eine lokale GPU dauerhaft zu binden.
 *
 * Bewusst derselbe `RateLimiter` wie MCP-Server (M10), eingehende
 * Föderation (M11) und die anonymen Routen (M13): ein gleitendes
 * Minutenfenster, prozesslokal, ohne neue Abhängigkeit.
 *
 * Unterschied zu `publicRateLimit`: Hier zählt **jeder** Aufrufer, auch
 * der angemeldete. Der Grund ist nicht Missbrauch, sondern Kosten — ein
 * angemeldeter Nutzer kann dieselbe Quote verbrennen wie ein anonymer.
 * Gezählt wird pro Identität, und wo es keine gibt, pro Absenderadresse.
 */

import { RateLimiter } from '@/lib/graph/mcp/limits';
import { requestOrigin } from '@/lib/graph/authz/public-limits';

/**
 * Voreinstellung: zwanzig Turns je Minute und Nutzer. Hoch genug, dass
 * niemand beim Arbeiten dagegen läuft (ein Turn dauert Sekunden), niedrig
 * genug, dass eine Schleife im Client nach drei Sekunden auffällt.
 * Über `OW_CHAT_RATE_LIMIT` anpassbar, `0` schaltet es ab.
 */
export const DEFAULT_CHAT_LIMIT_PER_MINUTE = 20;

/** Nur der eine Schlüssel, den dieses Modul liest (wie `IdentityEnv`). */
export interface ChatLimitEnv {
    [key: string]: string | undefined;
    OW_CHAT_RATE_LIMIT?: string;
}

export function chatLimitPerMinute(env: ChatLimitEnv = process.env): number {
    const raw = env.OW_CHAT_RATE_LIMIT?.trim();
    if (!raw) return DEFAULT_CHAT_LIMIT_PER_MINUTE;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CHAT_LIMIT_PER_MINUTE;
    return parsed;
}

const globalLimiter = globalThis as unknown as { __owChatLimiter?: RateLimiter };

function limiter(): RateLimiter {
    if (!globalLimiter.__owChatLimiter) globalLimiter.__owChatLimiter = new RateLimiter(Date.now);
    return globalLimiter.__owChatLimiter;
}

export interface ChatRateLimitRefusal {
    /** Fertige Fehlermeldung für den Client — im Klartext, mit Wartezeit. */
    error: string;
    retryAfterSeconds: number;
}

/**
 * Prüft das Limit für einen Chat-Turn. Rückgabe `null` = erlaubt.
 *
 * Die Route baut daraus ihre 429-Antwort selbst, weil sie im Streaming-
 * Fall ein anderes Format schreibt als im Einmal-Fall — das Limit
 * entscheidet, die Route formuliert.
 */
export function checkChatRateLimit(
    request: Request,
    identity: string | null,
    options: { perMinute?: number; limiterInstance?: RateLimiter } = {},
): ChatRateLimitRefusal | null {
    const perMinute = options.perMinute ?? chatLimitPerMinute();
    if (perMinute <= 0) return null;
    const key = identity ? `chat:user:${identity}` : `chat:origin:${requestOrigin(request)}`;
    const decision = (options.limiterInstance ?? limiter()).check(key, perMinute);
    if (decision.allowed) return null;
    return {
        error: `Zu viele Anfragen an den Assistenten (${perMinute} pro Minute). Erneut versuchen in ${decision.retryAfterSeconds} s.`,
        retryAfterSeconds: decision.retryAfterSeconds,
    };
}
