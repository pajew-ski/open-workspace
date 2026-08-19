// @vitest-environment node
/**
 * Rate-Limit des Chat-Endpunkts (ANALYSE §5 P2.11).
 *
 * Der Chat war die letzte schreibende Route ohne Limit. Geprüft wird das,
 * was die Route entscheidet: das gleitende Minutenfenster, die Trennung
 * der Eimer (geprüfte Identität eigen, alles andere nach Absender), die
 * Wartezeit für `Retry-After` und die Abschaltbarkeit.
 */

import { describe, expect, it } from 'vitest';
import { RateLimiter } from '@/lib/graph/mcp/limits';
import {
    DEFAULT_CHAT_LIMIT_PER_MINUTE,
    chatLimitPerMinute,
    checkChatRateLimit,
} from '@/lib/ai/server/chat-limits';

function requestFrom(ip?: string): Request {
    return new Request('https://ws.example.org/api/chat', {
        method: 'POST',
        headers: ip ? { 'x-forwarded-for': ip } : {},
    });
}

describe('chatLimitPerMinute', () => {
    it('nimmt die Voreinstellung, wenn nichts gesetzt ist', () => {
        expect(chatLimitPerMinute({})).toBe(DEFAULT_CHAT_LIMIT_PER_MINUTE);
        expect(chatLimitPerMinute({ OW_CHAT_RATE_LIMIT: '  ' })).toBe(DEFAULT_CHAT_LIMIT_PER_MINUTE);
    });

    it('liest eine gesetzte Grenze und ignoriert Unsinn', () => {
        expect(chatLimitPerMinute({ OW_CHAT_RATE_LIMIT: '5' })).toBe(5);
        expect(chatLimitPerMinute({ OW_CHAT_RATE_LIMIT: '0' })).toBe(0);
        expect(chatLimitPerMinute({ OW_CHAT_RATE_LIMIT: '-3' })).toBe(DEFAULT_CHAT_LIMIT_PER_MINUTE);
        expect(chatLimitPerMinute({ OW_CHAT_RATE_LIMIT: 'viele' })).toBe(DEFAULT_CHAT_LIMIT_PER_MINUTE);
    });
});

describe('checkChatRateLimit', () => {
    it('lässt bis zur Grenze durch und lehnt danach mit Wartezeit ab', () => {
        let now = 1_000_000;
        const limiterInstance = new RateLimiter(() => now);
        const options = { perMinute: 3, limiterInstance };

        for (let i = 0; i < 3; i++) {
            expect(checkChatRateLimit(requestFrom('10.0.0.1'), 'alice', options)).toBeNull();
            now += 1_000;
        }

        const refused = checkChatRateLimit(requestFrom('10.0.0.1'), 'alice', options);
        expect(refused).not.toBeNull();
        expect(refused!.error).toContain('3 pro Minute');
        // Der älteste Treffer liegt drei Sekunden zurück: 57 s bis frei.
        expect(refused!.retryAfterSeconds).toBe(57);

        // Nach Ablauf des Fensters wieder offen.
        now += 60_000;
        expect(checkChatRateLimit(requestFrom('10.0.0.1'), 'alice', options)).toBeNull();
    });

    it('zählt geprüfte Identitäten getrennt — bob zahlt nicht für alice', () => {
        const limiterInstance = new RateLimiter(() => 5_000);
        const options = { perMinute: 1, limiterInstance };

        expect(checkChatRateLimit(requestFrom('10.0.0.1'), 'alice', options)).toBeNull();
        expect(checkChatRateLimit(requestFrom('10.0.0.1'), 'alice', options)).not.toBeNull();
        // Gleiche Adresse, andere Identität: eigener Eimer.
        expect(checkChatRateLimit(requestFrom('10.0.0.1'), 'bob', options)).toBeNull();
    });

    it('ohne geprüfte Identität zählt der Absender, nicht ein gemeinsamer Nutzer', () => {
        const limiterInstance = new RateLimiter(() => 5_000);
        const options = { perMinute: 1, limiterInstance };

        expect(checkChatRateLimit(requestFrom('10.0.0.1'), null, options)).toBeNull();
        expect(checkChatRateLimit(requestFrom('10.0.0.1'), null, options)).not.toBeNull();
        expect(checkChatRateLimit(requestFrom('10.0.0.2'), null, options)).toBeNull();
        // Ohne jede Absenderangabe bleibt ein gemeinsamer Eimer — lieber
        // ein zu strenges gemeinsames Limit als gar keins.
        expect(checkChatRateLimit(requestFrom(), null, options)).toBeNull();
        expect(checkChatRateLimit(requestFrom(), null, options)).not.toBeNull();
    });

    it('ist mit 0 abgeschaltet', () => {
        const limiterInstance = new RateLimiter(() => 5_000);
        for (let i = 0; i < 50; i++) {
            expect(checkChatRateLimit(requestFrom('10.0.0.1'), 'alice', { perMinute: 0, limiterInstance })).toBeNull();
        }
    });
});
