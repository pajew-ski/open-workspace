import { test, expect, Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * E2E: automatisierte Accessibility-Scans (axe-core) auf allen Kernseiten.
 *
 * Gate: Verstöße mit Impact serious/critical (WCAG A/AA) brechen den
 * Build. Läuft auf Desktop UND Mobile; Light- und Dark-Mode werden auf
 * einer Teilmenge geprüft. moderate/minor werden bewusst nicht gebrochen,
 * damit das Gate stabil bleibt — neue ernste Regressionen aber sofort
 * auffallen.
 */

const PAGES = [
    '/',
    '/tasks',
    '/calendar',
    '/docs',
    '/canvas',
    '/communication',
    '/agents',
    '/ai',
    '/skills',
    '/tools',
    '/graph',
    '/graph/connectors',
    '/graph/observations',
    '/graph/causal',
    '/graph/sparql',
    '/graph/federation',
    '/graph/access',
    '/settings',
    '/assistant',
    '/onboarding',
];

/**
 * Dark Mode auf ALLEN Seiten (TODO P2 „A11y-Feinschliff", zweite Hälfte).
 * Vorher lief der Dunkel-Scan auf drei Seiten — Kontrastfehler in den
 * Graph-Oberflächen, die eigene Farbskalen mitbringen (Herkunfts-Chips,
 * Kausal-Editor, Föderations-Status), fielen damit systematisch nicht auf.
 */
const DARK_MODE_PAGES = PAGES;

/**
 * Seiten laden Inhalte asynchron nach (Tasks, Widgets, Docs). Der Scan
 * muss den Endzustand sehen, sonst prüfen Light- und Dark-Läufe
 * unterschiedliche DOMs.
 */
async function gotoAndSettle(page: Page, path: string) {
    await page.goto(path);
    await expect(page.locator('#main-content')).toBeVisible();
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => { });
    await page.waitForTimeout(400);
}

async function expectNoSevereViolations(page: Page, include?: string) {
    let builder = new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
    if (include) {
        builder = builder.include(include);
    }
    const results = await builder.analyze();

    const severe = results.violations
        .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
        .map((violation) => ({
            id: violation.id,
            impact: violation.impact,
            help: violation.help,
            nodes: violation.nodes.slice(0, 5).map((node) => node.target.join(' ')),
        }));

    expect(severe, JSON.stringify(severe, null, 2)).toEqual([]);
}

for (const path of PAGES) {
    test(`axe: ${path} ohne ernste Verstöße (Light)`, async ({ page }) => {
        await gotoAndSettle(page, path);
        await expectNoSevereViolations(page);
    });
}

for (const path of DARK_MODE_PAGES) {
    test(`axe: ${path} ohne ernste Verstöße (Dark)`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await gotoAndSettle(page, path);
        await expect
            .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme')))
            .toBe('dark');
        await expectNoSevereViolations(page);
    });
}

test('axe: offener Navigations-Drawer ohne ernste Verstöße', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Der Drawer existiert nur auf Mobile');

    await page.goto('/');
    await page.getByRole('button', { name: 'Menü öffnen' }).click();
    await expect(page.getByRole('dialog', { name: 'Hauptmenü' })).toBeVisible();
    // Nur den Dialog scannen: der Hintergrund liegt unter der Abdunkelung,
    // dort berechnet axe Kontraste gegen den Overlay-Mix
    await expectNoSevereViolations(page, '#app-sidebar');
});

test('axe: offener Finder-Dialog ohne ernste Verstöße', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('global-finder-trigger').click();
    await expect(page.getByTestId('global-finder-dialog')).toBeVisible();
    await expectNoSevereViolations(page, '[data-testid="global-finder-dialog"]');
});

test('Seite bleibt bei 200% Zoom nutzbar (kein horizontaler Verlust)', async ({ page, isMobile }) => {
    test.skip(isMobile, 'Zoom-Reflow ist ein Desktop-Kriterium (WCAG 1.4.10)');

    // 1280px bei 200% Zoom entspricht effektiv 640px Breite — Inhalte
    // müssen umbrechen statt horizontal zu scrollen
    await page.setViewportSize({ width: 640, height: 512 });
    await page.goto('/');
    await expect(page.locator('#main-content')).toBeVisible();

    const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);
});
