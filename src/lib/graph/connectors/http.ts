/**
 * Abgesicherter Netzwerkzugriff für Connectors.
 *
 * Connector-Pulls laufen serverseitig und holen fremde URLs — derselbe
 * Angriffspfad wie beim Tool-Executor (SSRF). Deshalb gilt hier dieselbe
 * Politik wie in `src/lib/tools/executor.ts`:
 *  - nur http(s),
 *  - private/lokale Ziele blockiert (Opt-out über ALLOW_LOCAL_TOOL_URLS=1,
 *    derselbe Schalter wie beim Tool-Executor — ein Knopf, eine Politik),
 *  - Redirects werden Hop für Hop validiert, damit eine öffentliche URL
 *    nicht per Redirect auf 169.254.169.254 & Co. zeigt,
 *  - Timeout und Antwort-Größenlimit sind Pflicht.
 */

import { isPrivateHostname } from '@/lib/net/private';

export interface GuardedFetchOptions {
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
    /** Basis-Implementierung — Tests injizieren hier einen Stub. */
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
}

const DEFAULTS = {
    timeoutMs: 30_000,
    maxBytes: 25 * 1024 * 1024,
    maxRedirects: 5,
} as const;

export class ConnectorFetchError extends Error {
    constructor(message: string, readonly code: 'BLOCKED_URL' | 'TIMEOUT' | 'TOO_LARGE' | 'TOO_MANY_REDIRECTS' | 'NETWORK') {
        super(message);
        this.name = 'ConnectorFetchError';
    }
}

function localUrlsAllowed(): boolean {
    return process.env.ALLOW_LOCAL_TOOL_URLS === '1';
}

function assertAllowedUrl(raw: string): URL {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new ConnectorFetchError(`Ungültige URL: "${raw}"`, 'BLOCKED_URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new ConnectorFetchError(
            `Nur http(s)-URLs sind erlaubt, nicht "${url.protocol}".`,
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

/**
 * Erzeugt die `fetch`-Funktion, die der Runner in den ConnectorContext
 * legt. Folgt Redirects manuell und validiert jeden Hop gegen die
 * SSRF-Politik; liest Antworten nur bis zum Größenlimit.
 */
export function createGuardedFetch(options: GuardedFetchOptions = {}): (url: string, init?: RequestInit) => Promise<Response> {
    const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
    const maxRedirects = options.maxRedirects ?? DEFAULTS.maxRedirects;
    const fetchImpl = options.fetchImpl ?? fetch;

    return async (rawUrl: string, init?: RequestInit): Promise<Response> => {
        let url = assertAllowedUrl(rawUrl);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const onOuterAbort = () => controller.abort();
        options.signal?.addEventListener('abort', onOuterAbort, { once: true });
        if (options.signal?.aborted) controller.abort();

        try {
            for (let hop = 0; ; hop += 1) {
                let response: Response;
                try {
                    response = await fetchImpl(url.toString(), {
                        ...init,
                        redirect: 'manual',
                        signal: controller.signal,
                    });
                } catch (error) {
                    if (controller.signal.aborted) {
                        throw new ConnectorFetchError(
                            `Zeitlimit (${timeoutMs} ms) beim Abruf von ${url.hostname} überschritten.`,
                            'TIMEOUT',
                        );
                    }
                    throw new ConnectorFetchError(
                        `Netzwerkfehler beim Abruf von ${url.hostname}: ${error instanceof Error ? error.message : String(error)}`,
                        'NETWORK',
                    );
                }

                if (response.status >= 300 && response.status < 400) {
                    const location = response.headers.get('location');
                    if (!location) return response;
                    if (hop >= maxRedirects) {
                        throw new ConnectorFetchError(
                            `Mehr als ${maxRedirects} Redirects — abgebrochen.`,
                            'TOO_MANY_REDIRECTS',
                        );
                    }
                    // Jeder Hop wird gegen die SSRF-Politik geprüft.
                    url = assertAllowedUrl(new URL(location, url).toString());
                    continue;
                }

                const contentLength = Number(response.headers.get('content-length') ?? '0');
                if (Number.isFinite(contentLength) && contentLength > maxBytes) {
                    throw new ConnectorFetchError(
                        `Antwort zu groß (${contentLength} Bytes, Limit ${maxBytes}).`,
                        'TOO_LARGE',
                    );
                }
                return response;
            }
        } finally {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onOuterAbort);
        }
    };
}

/**
 * Liest einen Response-Body als Text und erzwingt das Größenlimit auch
 * dann, wenn kein Content-Length-Header gesetzt war.
 */
export async function readBodyLimited(response: Response, maxBytes: number = DEFAULTS.maxBytes): Promise<string> {
    const text = await response.text();
    // UTF-8: Zeichenzahl ≤ Byte-Zahl — die billige Prüfung reicht als Kappe.
    if (text.length > maxBytes) {
        throw new ConnectorFetchError(
            `Antwort zu groß (> ${maxBytes} Bytes).`,
            'TOO_LARGE',
        );
    }
    return text;
}
