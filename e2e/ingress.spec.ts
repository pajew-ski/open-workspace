import { test, expect, type Page } from '@playwright/test';

/**
 * Ingress-Base-Path (SPEC §5.2, Abnahme M12).
 *
 * Der Prüfstand (scripts/e2e-ingress-server.mjs) stellt die echte Kette
 * nach: Supervisor-Simulation entfernt `/api/hassio_ingress/<token>` und
 * meldet es im Header, der Ingress-Proxy des Add-ons setzt es wieder vor
 * den Pfad, dahinter läuft derselbe Standalone-Build wie im Image — mit
 * dem beim Start eingesetzten Base-Path.
 *
 * Geprüft wird das, woran eine nicht base-path-fähige PWA scheitert:
 * Assets, Client-Navigation, eigene fetch-Aufrufe, Service-Worker-Scope
 * und Manifest. „Die Seite lädt" allein wäre kein Nachweis — ein
 * fehlender Präfix fällt erst beim zweiten Klick auf.
 */

const INGRESS = '/api/hassio_ingress/e2e-token';

/**
 * Sammelt fehlgeschlagene Anfragen AN DIE APP — die Zeugen für falsche URLs.
 *
 * Bewusst gefiltert: Fremde Origins (Modell-Endpunkte, Bilder aus dem Netz)
 * gehören nicht zu dieser Abnahme und sind in Sandboxen ohnehin nicht
 * erreichbar; abgebrochene Prefetches (`ERR_ABORTED`) sind normales
 * Router-Verhalten beim Navigieren, kein Fehler.
 */
function collectFailures(page: Page, baseURL: string): string[] {
    const failures: string[] = [];
    const mine = (url: string) => url.startsWith(baseURL);
    page.on('response', response => {
        if (mine(response.url()) && response.status() >= 400) {
            failures.push(`${response.status()} ${response.url()}`);
        }
    });
    page.on('requestfailed', request => {
        const reason = request.failure()?.errorText ?? '';
        if (mine(request.url()) && !reason.includes('ERR_ABORTED')) {
            failures.push(`${reason} ${request.url()}`);
        }
    });
    return failures;
}

test.describe('Home-Assistant-Ingress', () => {
    test('lädt die App unter dem Ingress-Präfix, ohne eine einzige Fehl-URL', async ({ page, baseURL }) => {
        const failures = collectFailures(page, baseURL as string);
        await page.goto(`${INGRESS}`);

        await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
        // Alle Assets liegen hinter dem Präfix — sonst holt der Browser sie
        // von der Wurzel des Home-Assistant-Hosts und bekommt 404.
        expect(failures, `Fehlgeschlagene Anfragen: ${failures.join(', ')}`).toEqual([]);
    });

    test('behält das Präfix bei der Client-Navigation', async ({ page, baseURL }) => {
        const failures = collectFailures(page, baseURL as string);
        await page.goto(`${INGRESS}`);

        // Genau hier bricht eine App ohne basePath: der Router schiebt
        // `/tasks` in die History und landet außerhalb des Ingress.
        await page.getByRole('link', { name: 'Aufgaben' }).first().click();
        await expect(page).toHaveURL(new RegExp(`${INGRESS}/tasks$`));
        await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
        expect(failures, `Fehlgeschlagene Anfragen: ${failures.join(', ')}`).toEqual([]);
    });

    test('präfixt eigene fetch-Aufrufe der Anwendung', async ({ page }) => {
        await page.goto(`${INGRESS}`);

        // Der Filter aus lib/platform/base-path.ts hängt am window.fetch der
        // Seite: Feature-Code ruft weiter `/api/...` auf.
        const result = await page.evaluate(async () => {
            const response = await fetch('/api/runtime', { cache: 'no-store' });
            return { url: response.url, status: response.status, body: await response.json() };
        });

        expect(result.status).toBe(200);
        expect(new URL(result.url).pathname).toBe(`${INGRESS}/api/runtime`);
        expect(result.body.runtime).toBe('ha-addon');
        expect(result.body.basePath).toBe(INGRESS);
        expect(result.body.ingress).toEqual({ active: true, basePath: INGRESS });
        // Home Assistant meldet den angemeldeten Nutzer über Ingress-Header.
        expect(result.body.identity).toMatchObject({
            mode: 'ha-ingress',
            authenticated: true,
            userId: 'ha-e2e-user',
        });
        // Ehrliche Fähigkeiten: Mehrbenutzerbetrieb gibt es hier nicht.
        expect(result.body.capabilities.multiUser).toBe(false);
        expect(result.body.capabilities.mcpServer).toBe(true);
    });

    test('liefert Manifest und Service-Worker-Scope unter dem Präfix', async ({ page, request }) => {
        await page.goto(`${INGRESS}`);

        const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
        expect(manifestHref).toBe(`${INGRESS}/manifest.webmanifest`);

        const manifest = await (await request.get(`${INGRESS}/manifest.webmanifest`)).json();
        expect(manifest.start_url).toBe(`${INGRESS}/`);
        expect(manifest.scope).toBe(`${INGRESS}/`);
        expect(manifest.icons[0].src).toBe(`${INGRESS}/icons/icon-192.png`);
        expect(manifest.shortcuts[0].url).toBe(`${INGRESS}/tasks`);

        // Der Service Worker liegt hinter dem Präfix und leitet seinen
        // eigenen Base-Path daraus ab (public/sw.js).
        const worker = await request.get(`${INGRESS}/sw.js`);
        expect(worker.status()).toBe(200);
        expect(await worker.text()).toContain('self.registration.scope');
    });

    test('liefert außerhalb des Ingress-Pfads nichts aus', async ({ request }) => {
        // Die Supervisor-Simulation antwortet wie Home Assistant: was nicht
        // unter dem Ingress-Pfad liegt, existiert für den Browser nicht.
        expect((await request.get('/', { failOnStatusCode: false })).status()).toBe(404);
    });
});
