import { defineConfig, devices } from '@playwright/test';

/**
 * E2E test configuration.
 *
 * Runs against a production build (`next start`). Projekte:
 * - `chromium`: Desktop Chrome
 * - `mobile-chromium`: Pixel-7-Emulation (Touch, Mobile-Viewport) — hier
 *   laufen Drawer-, Touch-Target- und Overflow-Suiten; Desktop-only-Tests
 *   überspringen sich dort selbst via `isMobile`.
 * - `ingress`: Home-Assistant-Ingress (M12). Eigener Server auf Port 3100
 *   (scripts/e2e-ingress-server.mjs): zweiter Build mit Base-Path-
 *   Platzhalter, Supervisor-Simulation, Ingress-Proxy. Läuft nur für
 *   e2e/ingress.spec.ts — die anderen Projekte lassen die Datei aus.
 *
 * The chat E2E test additionally needs a reachable LLM endpoint (see
 * .env.example) and is skipped automatically when none is configured.
 */

// Environments with a preinstalled Chromium (e.g. sandboxes) can point
// here instead of downloading a browser.
const launchOptions = process.env.CHROMIUM_PATH
    ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } }
    : {};

const INGRESS_BASE = 'http://localhost:3100/api/hassio_ingress/e2e-token';

export default defineConfig({
    testDir: './e2e',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    reporter: process.env.CI ? 'github' : 'list',
    use: {
        baseURL: 'http://localhost:3000',
        trace: 'on-first-retry',
    },
    projects: [
        {
            name: 'chromium',
            testIgnore: /ingress\.spec\.ts/,
            use: {
                ...devices['Desktop Chrome'],
                ...launchOptions,
            },
        },
        {
            name: 'mobile-chromium',
            testIgnore: /ingress\.spec\.ts/,
            use: {
                ...devices['Pixel 7'],
                ...launchOptions,
            },
        },
        {
            name: 'ingress',
            testMatch: /ingress\.spec\.ts/,
            use: {
                ...devices['Desktop Chrome'],
                ...launchOptions,
                baseURL: INGRESS_BASE,
            },
        },
    ],
    webServer: [
        {
            command: 'bun run start',
            url: 'http://localhost:3000',
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
        },
        {
            // Baut beim ersten Lauf `.next-ingress` (Platzhalter-Base-Path)
            // und startet die Ingress-Kette; danach wird der Build wiederverwendet.
            command: 'node scripts/e2e-ingress-server.mjs',
            url: `${INGRESS_BASE}/`,
            reuseExistingServer: !process.env.CI,
            timeout: 420_000,
        },
    ],
});
