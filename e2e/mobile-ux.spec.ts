import { test, expect } from '@playwright/test';

/**
 * E2E: mobile UX-Grundregeln auf allen Kernseiten.
 *
 * Pro Seite werden drei dauerhafte Garantien geprüft:
 * 1. Kein horizontales Scrollen (Layout passt in den Viewport)
 * 2. Interaktive Elemente sind mindestens 24×24px groß (WCAG 2.5.8);
 *    die primären Bedienelemente (Burger, FABs) mindestens 44×44px
 * 3. Formularfelder haben mindestens 16px Schrift (sonst zoomt iOS
 *    Safari beim Fokussieren in die Seite)
 *
 * Läuft nur im Mobile-Projekt.
 */

test.skip(({ isMobile }) => !isMobile, 'Mobile-Grundregeln gelten für den Mobile-Viewport');

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
    '/graph/sparql',
    '/graph/federation',
    '/graph/access',
    '/settings',
    '/assistant',
    '/onboarding',
];

for (const path of PAGES) {
    test(`Mobile-Grundregeln auf ${path}`, async ({ page }) => {
        await page.goto(path);
        await expect(page.locator('#main-content')).toBeVisible();
        // Asynchron nachgeladene Inhalte abwarten, damit der Scan den
        // Endzustand prüft (Tasks, Widgets, Listen)
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => { });
        await page.waitForTimeout(400);

        // 1. Kein horizontaler Overflow
        const overflow = await page.evaluate(() => ({
            document: document.documentElement.scrollWidth - window.innerWidth,
            body: document.body.scrollWidth - window.innerWidth,
        }));
        expect.soft(overflow.document, 'documentElement breiter als Viewport').toBeLessThanOrEqual(1);
        expect.soft(overflow.body, 'body breiter als Viewport').toBeLessThanOrEqual(1);

        // 2. Touch-Target-Mindestgröße (WCAG 2.5.8: 24×24 CSS-Pixel).
        //    Ausgenommen: Inline-Links im Fließtext (WCAG-Ausnahme) und
        //    native Checkboxen/Radios (Ziel ist die beschriftete Zeile).
        const tooSmall = await page.evaluate(() => {
            const MIN = 24;
            const offenders: string[] = [];
            const candidates = document.querySelectorAll<HTMLElement>(
                'button, a[href], [role="button"], select, textarea, ' +
                'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])'
            );
            for (const el of candidates) {
                const style = getComputedStyle(el);
                if (style.display === 'inline') continue;
                if (style.visibility === 'hidden' || style.display === 'none') continue;
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) continue;
                // Screenreader-only (Clip-Pattern, z.B. Skip-Link): visuell
                // 1×1px, per Touch nicht antippbar — kein Touch-Target
                if (rect.width <= 1 && rect.height <= 1) continue;
                if (rect.width + 0.5 >= MIN && rect.height + 0.5 >= MIN) continue;
                const name = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40);
                offenders.push(
                    `<${el.tagName.toLowerCase()}> "${name}" ${Math.round(rect.width)}×${Math.round(rect.height)}px`
                );
            }
            return offenders;
        });
        expect.soft(tooSmall, `Touch-Targets unter 24×24px:\n${tooSmall.join('\n')}`).toEqual([]);

        // 3. Formularfelder: nie unter 16px Schrift
        const smallInputs = await page.evaluate(() =>
            Array.from(document.querySelectorAll<HTMLElement>('input, textarea, select'))
                .filter((el) => {
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                })
                .map((el) => ({
                    id: el.id || el.getAttribute('name') || el.tagName.toLowerCase(),
                    fontSize: parseFloat(getComputedStyle(el).fontSize),
                }))
                .filter((entry) => entry.fontSize < 16)
        );
        expect
            .soft(smallInputs, `Felder unter 16px lösen iOS-Autozoom aus: ${JSON.stringify(smallInputs)}`)
            .toEqual([]);
    });
}

test('Primäre Bedienelemente erreichen 44×44px', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#main-content')).toBeVisible();

    const primaryControls: Array<{ label: string; locator: ReturnType<typeof page.getByRole> }> = [
        { label: 'Burger-Menü', locator: page.getByRole('button', { name: 'Menü öffnen' }) },
        { label: 'Benachrichtigungen', locator: page.getByRole('button', { name: /Benachrichtigungen/ }) },
        { label: 'Chat-FAB', locator: page.getByTestId('assistant-chat-fab') },
        { label: 'Finder-Trigger', locator: page.getByTestId('global-finder-trigger') },
    ];

    for (const control of primaryControls) {
        const box = await control.locator.boundingBox();
        expect(box, `${control.label} nicht gefunden`).not.toBeNull();
        expect.soft(box!.width, `${control.label}: Breite`).toBeGreaterThanOrEqual(44);
        expect.soft(box!.height, `${control.label}: Höhe`).toBeGreaterThanOrEqual(44);
    }
});

test('FAB-Reihe verdeckt sich nicht gegenseitig', async ({ page }) => {
    await page.goto('/tasks');
    await expect(page.locator('#main-content')).toBeVisible();

    // Chat-FAB und Finder-Trigger müssen beide direkt antippbar sein
    for (const testId of ['assistant-chat-fab', 'global-finder-trigger']) {
        const box = await page.getByTestId(testId).boundingBox();
        expect(box, `${testId} nicht sichtbar`).not.toBeNull();
        const center = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
        const hitsSelf = await page.evaluate(
            ({ x, y, id }) => Boolean(
                document.elementFromPoint(x, y)?.closest(`[data-testid="${id}"]`)
            ),
            { ...center, id: testId }
        );
        expect(hitsSelf, `${testId} wird an (${center.x},${center.y}) von einem anderen Element verdeckt`).toBe(true);
    }
});

test('Globaler Finder ist als mobiler Dialog nutzbar', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#main-content')).toBeVisible();

    const trigger = page.getByTestId('global-finder-trigger');
    await trigger.click();

    const dialog = page.getByTestId('global-finder-dialog');
    await expect(dialog).toBeVisible();

    // Fokus liegt sofort im Suchfeld — ohne zusätzlichen Tap tippbar
    const input = dialog.getByRole('combobox', { name: 'Suchbegriff' });
    await expect(input).toBeFocused();

    // Der Dialog passt in den Viewport
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.x).toBeGreaterThanOrEqual(0);

    // Escape schließt und gibt den Fokus an den Trigger zurück
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
});
