/**
 * Der zweite Kanal zu Home Assistant: die WebSocket-API.
 *
 * Bis hierher kam der Kausal-Layer mit REST aus — Inventar über
 * `POST /api/template`, Verlauf über `/api/history/period`. Eine Sache
 * kennt die REST-API aber nicht, und es ist ausgerechnet die, die den
 * Bestand nach hinten verlängert: die **Long-Term-Statistics**
 * (`recorder/statistics_during_period`). Sie liegen allein hinter der
 * WebSocket-API.
 *
 * Warum trotzdem keine zweite Protokollschicht im großen Sinn entsteht:
 * Diese Datei bringt genau so viel WebSocket mit, wie ein Kommando mit
 * einer Antwort braucht — öffnen, senden, lesen, schließen. Es gibt kein
 * Abonnement, keine Ereignisschleife, keinen Wiederverbindungsversuch.
 * Ein Rückgriff auf die Statistik ist eine einmalige, angeforderte
 * Handlung, kein Dauerlauscher.
 *
 * **Dieselbe Politik wie beim Abruf über HTTP** (`http.ts`): nur ws(s),
 * private/lokale Ziele blockiert (Opt-out über `ALLOW_LOCAL_TOOL_URLS=1`,
 * derselbe Schalter — ein Knopf, eine Politik), Zeitlimit Pflicht. Ein
 * Redirect gibt es beim WebSocket-Handshake nicht zu validieren; die
 * Prüfung greift deshalb einmal, an der einen Adresse.
 *
 * Der Kanal ist als schmale Schnittstelle (`WebSocketLike`) modelliert
 * und wird hereingereicht — genau wie `FileSystemLike` und der
 * abgesicherte `fetch`. Damit läuft die Abnahme gegen einen gescripteten
 * Doppelgänger statt gegen eine echte Installation, und die Runtime
 * `local` (die diese Datei nie erreicht) bleibt außen vor.
 */

import { isPrivateHostname } from '@/lib/net/private';
import { ConnectorFetchError } from '../http';

/** Ein Textkanal: senden, empfangen, schließen. Mehr braucht es nicht. */
export interface WebSocketLike {
    send(payload: string): void;
    close(): void;
    /** Empfänger für Textnachrichten der Gegenstelle. */
    onMessage(handler: (payload: string) => void): void;
    /** Ende des Kanals — regulär geschlossen oder gescheitert, mit Grund. */
    onClose(handler: (reason: string) => void): void;
}

/** Öffnet einen Kanal und liefert ihn erst zurück, wenn er offen ist. */
export type WebSocketOpener = (url: string) => Promise<WebSocketLike>;

export interface WebSocketOptions {
    /** Zeitlimit für den Verbindungsaufbau. */
    timeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

function localUrlsAllowed(): boolean {
    return process.env.ALLOW_LOCAL_TOOL_URLS === '1';
}

/**
 * `http(s)://host/basis` → `ws(s)://host/basis/api/websocket`.
 *
 * Die Basis ist dieselbe wie beim REST-Zugang (`HaAccess.baseUrl`), damit
 * es keine zweite konfigurierbare Adresse gibt, die auseinanderlaufen
 * kann — im Add-on `http://supervisor/core`, außerhalb die eingetragene
 * URL.
 */
export function websocketUrlFor(baseUrl: string): string {
    let url: URL;
    try {
        url = new URL(baseUrl);
    } catch {
        throw new ConnectorFetchError(`Ungültige Basis-URL: "${baseUrl}"`, 'BLOCKED_URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new ConnectorFetchError(
            `Nur http(s)-Basis-URLs sind erlaubt, nicht "${url.protocol}".`,
            'BLOCKED_URL',
        );
    }
    const path = `${url.pathname.replace(/\/+$/, '')}/api/websocket`;
    return `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}${path}`;
}

/** Prüft eine ws(s)-Adresse gegen dieselbe SSRF-Politik wie `http.ts`. */
export function assertAllowedWebSocketUrl(raw: string): URL {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new ConnectorFetchError(`Ungültige URL: "${raw}"`, 'BLOCKED_URL');
    }
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
        throw new ConnectorFetchError(
            `Nur ws(s)-URLs sind erlaubt, nicht "${url.protocol}".`,
            'BLOCKED_URL',
        );
    }
    if (!localUrlsAllowed() && isPrivateHostname(url.hostname)) {
        throw new ConnectorFetchError(
            `Zugriff auf private/lokale Adresse "${url.hostname}" blockiert. ` +
            'Setze ALLOW_LOCAL_TOOL_URLS=1, wenn lokale Quellen erlaubt sein sollen.',
            'BLOCKED_URL',
        );
    }
    return url;
}

/** Minimalausschnitt der globalen WebSocket-Klasse, den diese Datei nutzt. */
interface NativeSocket {
    send(payload: string): void;
    close(): void;
    addEventListener(type: 'open' | 'message' | 'close' | 'error', handler: (event: unknown) => void): void;
}

interface NativeSocketConstructor {
    new (url: string): NativeSocket;
}

/** Textinhalt eines Ereignisses — Node liefert Strings, Browser auch Blobs. */
function payloadOf(event: unknown): string | null {
    if (!event || typeof event !== 'object') return null;
    const data = (event as { data?: unknown }).data;
    return typeof data === 'string' ? data : null;
}

/**
 * Der reguläre Kanal: die globale `WebSocket`-Klasse der Laufzeit (Node
 * ab 22 und Bun bringen sie mit, eine Abhängigkeit kommt dafür nicht
 * hinzu). Fehlt sie, ist das ein ehrlicher Fehler und keine Attrappe.
 */
export function createGuardedWebSocketOpener(options: WebSocketOptions = {}): WebSocketOpener {
    const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

    return async (rawUrl: string): Promise<WebSocketLike> => {
        const url = assertAllowedWebSocketUrl(rawUrl);
        const Ctor = (globalThis as { WebSocket?: NativeSocketConstructor }).WebSocket;
        if (!Ctor) {
            throw new ConnectorFetchError(
                'Diese Laufzeit kennt keine WebSocket-Klasse — der Rückgriff auf die '
                + 'Langzeit-Statistik von Home Assistant braucht sie.',
                'NETWORK',
            );
        }

        const socket = new Ctor(url.toString());
        const messageHandlers: Array<(payload: string) => void> = [];
        const closeHandlers: Array<(reason: string) => void> = [];
        let closed = false;

        const finish = (reason: string) => {
            if (closed) return;
            closed = true;
            for (const handler of closeHandlers) handler(reason);
        };

        socket.addEventListener('message', event => {
            const payload = payloadOf(event);
            if (payload === null) return;
            for (const handler of messageHandlers) handler(payload);
        });
        socket.addEventListener('close', () => finish('Die Verbindung wurde geschlossen.'));
        socket.addEventListener('error', () => finish(`Die Verbindung zu ${url.host} ist gescheitert.`));

        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                socket.close();
                reject(new ConnectorFetchError(
                    `Zeitlimit (${timeoutMs} ms) beim Verbinden mit ${url.host} überschritten.`,
                    'TIMEOUT',
                ));
            }, timeoutMs);
            socket.addEventListener('open', () => {
                clearTimeout(timer);
                resolve();
            });
            socket.addEventListener('error', () => {
                clearTimeout(timer);
                reject(new ConnectorFetchError(
                    `Netzwerkfehler beim Verbinden mit ${url.host}.`,
                    'NETWORK',
                ));
            });
            socket.addEventListener('close', () => {
                clearTimeout(timer);
                reject(new ConnectorFetchError(
                    `Die Gegenstelle ${url.host} hat die Verbindung sofort geschlossen.`,
                    'NETWORK',
                ));
            });
        });

        return {
            send: payload => socket.send(payload),
            close: () => {
                socket.close();
                finish('Die Verbindung wurde geschlossen.');
            },
            onMessage: handler => messageHandlers.push(handler),
            onClose: handler => {
                if (closed) handler('Die Verbindung wurde geschlossen.');
                else closeHandlers.push(handler);
            },
        };
    };
}
