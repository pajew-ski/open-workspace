import { test, expect } from '@playwright/test';

/**
 * E2E: assistant chat widget behavior.
 *
 * The widget itself (open/close, persistence across client-side
 * navigation) is tested without any LLM. The conversational test at the
 * bottom needs a reachable inference endpoint and skips itself when the
 * health endpoint reports offline.
 *
 * Desktop-only: die Navigation läuft hier über die permanente Sidebar,
 * die es auf Mobile bewusst nicht gibt (dort: Drawer, siehe
 * mobile-navigation.spec.ts).
 */

test.skip(({ isMobile }) => Boolean(isMobile), 'Navigiert über die Desktop-Sidebar');

test('chat window opens and survives client-side navigation', async ({ page }) => {
    await page.goto('/');

    const fab = page.getByTestId('assistant-chat-fab');
    await expect(fab).toBeVisible();
    await fab.click();

    const chatWindow = page.getByTestId('assistant-chat-window');
    await expect(chatWindow).toBeVisible();

    // Navigate to the calendar via the sidebar — the widget must stay open
    await page.click('a[href="/calendar"]');
    await expect(page).toHaveURL(/\/calendar/);
    await expect(chatWindow).toBeVisible();
});

test('chat answers with page context', async ({ page, request }) => {
    const health = await request.get('/api/chat/health');
    const healthData = await health.json().catch(() => ({ status: 'error' }));
    test.skip(healthData.status !== 'online', 'No LLM endpoint reachable — skipping conversational E2E');

    await page.goto('/');
    await page.getByTestId('assistant-chat-fab').click();

    const input = page.getByTestId('assistant-chat-input');
    await input.fill('Auf welcher Seite bin ich gerade?');
    await input.press('Enter');

    await expect(page.getByTestId('assistant-chat-message-assistant').last())
        .toContainText(/Dashboard|Übersicht/i, { timeout: 60_000 });

    // Navigate and ask again — context must follow
    await page.click('a[href="/calendar"]');
    await expect(page.getByTestId('assistant-chat-window')).toBeVisible();

    await input.fill('Und jetzt?');
    await input.press('Enter');

    await expect(page.getByTestId('assistant-chat-message-assistant').last())
        .toContainText(/Kalender|Calendar/i, { timeout: 60_000 });
});
