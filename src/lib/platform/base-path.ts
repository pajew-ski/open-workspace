/**
 * Base-Path der Installation (SPEC §5.2, M12).
 *
 * Warum es das gibt: Home-Assistant-Ingress liefert die App unter einem
 * Präfix aus, das erst zur Installationszeit feststeht
 * (`/api/hassio_ingress/<token>`). Next kennt seinen `basePath` nur aus dem
 * Build — deshalb baut das Container-Image mit dem Platzhalter aus
 * `BASE_PATH_PLACEHOLDER` (unten), und `scripts/start.mjs` ersetzt ihn beim
 * Start (auch in dem hier eingebackenen `NEXT_PUBLIC_OW_BASE_PATH`).
 *
 * Next präfixt von sich aus, was durch seinen Router läuft: `<Link>`,
 * `next/image`, `_next/*`-Assets. NICHT präfixt werden eigene
 * `fetch('/api/...')`-Aufrufe, `navigator.serviceWorker.register` und
 * Anker auf statische Dateien. Genau dafür ist dieses Modul da:
 *
 *  - `withBasePath()` für alles, was eine URL als String braucht,
 *  - `installBasePathFetch()` als EINE Stelle, an der absolute
 *    Same-Origin-Pfade im Browser das Präfix bekommen. Ohne sie müssten
 *    ~95 Aufrufstellen in Feature-Code den Ingress kennen; sie kennen ihn
 *    jetzt an keiner Stelle.
 *
 * WICHTIG: Der Platzhalter wird hier NICHT als „ungültig" aussortiert. Er
 * ist zur Bauzeit ein gültiger Wert: Vorgerenderte Seiten enthalten dann
 * `<Platzhalter>/manifest.webmanifest`, und genau das ersetzt der Start-
 * Schritt durch den echten Pfad. Würde `getBasePath()` beim Bauen leer
 * liefern, stünde in der fertigen Seite ein Pfad OHNE Präfix — und der
 * ließe sich nachträglich durch nichts mehr reparieren.
 */

/**
 * Normalisiert einen Base-Path: ohne Schrägstrich am Ende, mit einem am
 * Anfang, leer für „kein Präfix". Wirft nicht — ein kaputter Wert ergibt
 * „kein Präfix", weil eine App ohne Präfix funktioniert und eine mit
 * halbem Präfix nicht.
 */
export function normalizeBasePath(value: string | undefined | null): string {
    if (!value) return '';
    let path = value.trim();
    if (!path || path === '/') return '';
    if (!path.startsWith('/')) path = `/${path}`;
    while (path.endsWith('/')) path = path.slice(0, -1);
    return path;
}

/**
 * Der Base-Path dieser Installation. Im Browser aus dem eingebackenen
 * (und beim Start ersetzten) Literal, auf dem Server zusätzlich aus
 * `OW_BASE_PATH` — dort ist der Wert zur Laufzeit verfügbar.
 */
export function getBasePath(): string {
    const fromBuild = normalizeBasePath(process.env.NEXT_PUBLIC_OW_BASE_PATH);
    if (fromBuild) return fromBuild;
    if (typeof window === 'undefined') return normalizeBasePath(process.env.OW_BASE_PATH);
    return '';
}

/** Präfixt einen absoluten App-Pfad. Fremde URLs bleiben unangetastet. */
export function withBasePath(path: string): string {
    const base = getBasePath();
    if (!base) return path;
    if (!path.startsWith('/')) return path;
    if (path === base || path.startsWith(`${base}/`)) return path;
    return `${base}${path}`;
}

/** Entfernt das Präfix wieder — für Vergleiche gegen Routen-Pfade. */
export function stripBasePath(path: string): string {
    const base = getBasePath();
    if (!base || !path.startsWith(base)) return path;
    const rest = path.slice(base.length);
    return rest.startsWith('/') ? rest : `/${rest}`;
}

type FetchFn = typeof fetch;

interface PatchedFetch extends FetchFn {
    __owBasePath?: string;
}

/**
 * Installiert den Base-Path-Filter auf `window.fetch` (idempotent).
 *
 * Umgeschrieben wird ausschließlich, was eindeutig ein App-Pfad ist: ein
 * String (oder `Request`) mit absolutem Pfad, der das Präfix noch nicht
 * trägt. Absolute URLs, protokoll-relative Adressen und alles ohne
 * führenden Schrägstrich bleiben, wie sie sind.
 *
 * Ohne Base-Path passiert gar nichts — der Normalbetrieb bleibt der
 * unveränderte `fetch` des Browsers.
 */
export function installBasePathFetch(): void {
    if (typeof window === 'undefined') return;
    const base = getBasePath();
    if (!base) return;
    const current = window.fetch as PatchedFetch;
    if (current.__owBasePath === base) return;

    const original = current;
    const patched: PatchedFetch = (input, init) => {
        if (typeof input === 'string') {
            return original(withBasePath(input), init);
        }
        if (input instanceof URL) {
            if (input.origin === window.location.origin) {
                const url = new URL(input.href);
                url.pathname = withBasePath(url.pathname);
                return original(url, init);
            }
            return original(input, init);
        }
        if (typeof Request !== 'undefined' && input instanceof Request) {
            const url = new URL(input.url);
            if (url.origin === window.location.origin) {
                const prefixed = withBasePath(url.pathname);
                if (prefixed !== url.pathname) {
                    url.pathname = prefixed;
                    return original(new Request(url, input), init);
                }
            }
            return original(input, init);
        }
        return original(input, init);
    };
    patched.__owBasePath = base;
    window.fetch = patched;
}
