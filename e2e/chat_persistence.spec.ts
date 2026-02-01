
import { test, expect } from '@playwright/test';

test('Chat persistence and context awareness', async ({ page }) => {
    // 1. Go to Dashboard
    await page.goto('http://localhost:3000/');

    // 2. Open Chat
    const chatButton = page.locator('button[aria-label="Assistant öffnen"]'); // Adjust selector as needed
    if (await chatButton.isVisible()) {
        await chatButton.click();
    } else {
        // Maybe keyboard shortcut?
        await page.keyboard.press('Control+Shift+a');
    }

    // 3. Send Message "Where am I?"
    const input = page.locator('input[placeholder="Frag mich etwas..."]'); // Adjust
    await input.fill('Where am I?');
    await page.keyboard.press('Enter');

    // 4. Wait for response containing "Dashboard"
    await expect(page.locator('.assistant-chat-message')).toContainText(/Dashboard|Übersicht/);

    // 5. Scroll up a bit (if possible) - hard to test programmatically without enough content

    // 6. Navigate to /calendar
    await page.click('a[href="/calendar"]'); // Sidebar link

    // 7. Verify Chat is STILL OPEN
    const chatWindow = page.locator('.assistant-chat-window'); // Adjust class
    await expect(chatWindow).toBeVisible();

    // 8. Send Message "And now?"
    await input.fill('And now?');
    await page.keyboard.press('Enter');

    // 9. Verify response contains "Calendar"
    await expect(page.locator('.assistant-chat-message').last()).toContainText(/Calendar|Kalender/);
});
