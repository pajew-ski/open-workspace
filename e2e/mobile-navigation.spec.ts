import { test, expect, Page } from '@playwright/test';

/**
 * E2E: mobiler Navigations-Drawer.
 *
 * Der Drawer muss sich wie ein modaler Dialog verhalten: über allen
 * Inhalten liegen (Regression: sticky Header/Toolbars und FABs stanzten
 * durch die Abdunkelung), Fokus fangen, per Escape schließbar sein und
 * den Hintergrund-Scroll sperren. Läuft nur im Mobile-Projekt.
 */

test.skip(({ isMobile }) => !isMobile, 'Der Drawer existiert nur auf Mobile');

async function openDrawer(page: Page) {
    const burger = page.getByRole('button', { name: 'Menü öffnen' });
    await burger.click();
    const drawer = page.getByRole('dialog', { name: 'Hauptmenü' });
    await expect(drawer).toBeVisible();
    return { burger, drawer };
}

test('Burger öffnet den Drawer als modalen Dialog', async ({ page }) => {
    await page.goto('/');

    const burger = page.getByRole('button', { name: 'Menü öffnen' });
    await expect(burger).toHaveAttribute('aria-expanded', 'false');
    await expect(burger).toHaveAttribute('aria-controls', 'app-sidebar');

    await burger.click();

    const drawer = page.getByRole('dialog', { name: 'Hauptmenü' });
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('aria-modal', 'true');
    await expect(burger).toHaveAttribute('aria-expanded', 'true');

    // Fokus wandert in den Dialog (auf den Schließen-Button)
    await expect(drawer.getByRole('button', { name: 'Menü schließen' })).toBeFocused();
});

test('Overlay deckt alle Inhalte ab — nichts stanzt durch', async ({ page }) => {
    // /tasks hat sticky Toolbars mit eigenem z-index — genau das Szenario,
    // in dem Inhalte früher über der Abdunkelung lagen
    await page.goto('/tasks');
    await openDrawer(page);

    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    const { width, height } = viewport!;

    // Rechts vom Drawer: Header-Zeile, sticky Toolbar, FAB-Ecke.
    // Überall muss der Tap auf dem Overlay landen, nie auf einem Control.
    const probePoints = [
        { x: width - 24, y: 28, label: 'Header (Glocke)' },
        { x: width - 24, y: 100, label: 'Sticky Toolbar' },
        { x: width - 24, y: height - 40, label: 'Chat-FAB' },
        { x: width - 84, y: height - 40, label: 'Finder-Trigger' },
        { x: width - 24, y: height / 2, label: 'Seitenmitte' },
    ];

    for (const point of probePoints) {
        const hit = await page.evaluate(({ x, y }) => {
            const el = document.elementFromPoint(x, y);
            return {
                onOverlay: Boolean(el?.closest('[data-testid="mobile-nav-overlay"]')),
                inDrawer: Boolean(el?.closest('#app-sidebar')),
                tag: el?.tagName ?? 'none',
            };
        }, point);
        expect(
            hit.onOverlay || hit.inDrawer,
            `${point.label} (${point.x},${point.y}): Tap trifft <${hit.tag}> statt Overlay/Drawer`
        ).toBe(true);
    }
});

test('Escape schließt den Drawer und gibt den Fokus zurück', async ({ page }) => {
    await page.goto('/');
    const { burger, drawer } = await openDrawer(page);

    await page.keyboard.press('Escape');

    await expect(drawer).toBeHidden();
    await expect(burger).toHaveAttribute('aria-expanded', 'false');
    await expect(burger).toBeFocused();
});

test('Tap auf das Overlay schließt den Drawer', async ({ page }) => {
    await page.goto('/');
    const { drawer } = await openDrawer(page);

    const viewport = page.viewportSize()!;
    await page.mouse.click(viewport.width - 24, viewport.height / 2);

    await expect(drawer).toBeHidden();
});

test('Navigation über den Drawer wechselt die Seite und schließt ihn', async ({ page }) => {
    await page.goto('/');
    const { drawer } = await openDrawer(page);

    await drawer.getByRole('link', { name: 'Aufgaben' }).click();

    await expect(page).toHaveURL(/\/tasks/);
    await expect(page.getByRole('dialog', { name: 'Hauptmenü' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Menü öffnen' })).toHaveAttribute('aria-expanded', 'false');

    // Der aktive Eintrag ist nach erneutem Öffnen als solcher markiert
    const { drawer: reopened } = await openDrawer(page);
    await expect(reopened.getByRole('link', { name: 'Aufgaben' })).toHaveAttribute('aria-current', 'page');
});

test('Hintergrund-Scroll ist gesperrt, solange der Drawer offen ist', async ({ page }) => {
    await page.goto('/');
    await openDrawer(page);

    await expect
        .poll(() => page.evaluate(() => getComputedStyle(document.body).overflow))
        .toBe('hidden');

    await page.keyboard.press('Escape');

    await expect
        .poll(() => page.evaluate(() => getComputedStyle(document.body).overflow))
        .not.toBe('hidden');
});

test('Tab-Fokus bleibt im offenen Drawer gefangen', async ({ page }) => {
    await page.goto('/');
    const { drawer } = await openDrawer(page);

    // Erst warten, bis der initiale Fokus im Dialog gelandet ist — sonst
    // rast das erste Tab dem asynchronen focus() davon und misst die
    // Öffnungs-Latenz statt der Fokus-Falle.
    await expect(drawer.getByRole('button', { name: 'Menü schließen' })).toBeFocused();

    // Mehr Tabs als der Drawer Elemente hat — der Fokus muss zyklisch
    // im Dialog bleiben und darf nie in den Hintergrund entweichen
    for (let i = 0; i < 15; i++) {
        await page.keyboard.press('Tab');
        const inDialog = await page.evaluate(() =>
            Boolean(document.activeElement?.closest('[role="dialog"]'))
        );
        expect(inDialog, `Fokus verließ den Drawer bei Tab #${i + 1}`).toBe(true);
    }
});

test('Geschlossener Drawer ist unsichtbar und nicht fokussierbar', async ({ page }) => {
    await page.goto('/');

    // visibility: hidden nimmt die Off-Canvas-Links aus der Tab-Reihenfolge
    await expect(page.locator('#app-sidebar')).toBeHidden();

    const visibility = await page
        .locator('#app-sidebar')
        .evaluate((el) => getComputedStyle(el).visibility);
    expect(visibility).toBe('hidden');
});
