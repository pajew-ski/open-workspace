import { defineConfig, devices } from '@playwright/test';

/**
 * E2E test configuration.
 *
 * Runs against a production build (`next start`). Two projects:
 * - `chromium`: Desktop Chrome
 * - `mobile-chromium`: Pixel-7-Emulation (Touch, Mobile-Viewport) — hier
 *   laufen Drawer-, Touch-Target- und Overflow-Suiten; Desktop-only-Tests
 *   überspringen sich dort selbst via `isMobile`.
 *
 * The chat E2E test additionally needs a reachable LLM endpoint (see
 * .env.example) and is skipped automatically when none is configured.
 */

// Environments with a preinstalled Chromium (e.g. sandboxes) can point
// here instead of downloading a browser.
const launchOptions = process.env.CHROMIUM_PATH
    ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } }
    : {};

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
            use: {
                ...devices['Desktop Chrome'],
                ...launchOptions,
            },
        },
        {
            name: 'mobile-chromium',
            use: {
                ...devices['Pixel 7'],
                ...launchOptions,
            },
        },
    ],
    webServer: {
        command: 'bun run start',
        url: 'http://localhost:3000',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
    },
});
