import type { Page } from "@playwright/test";
import { expect, gotoSync, pairWithPhone, test } from "./fixtures";

// Issue #230: "Sync now" restarts sync without a lock and unlock, and the log says when each line
// happened and which device it means. Unit tests pin each host's restart; only this proves a
// restarted session finds the other device again over a real relay.

/** The log's "synced with <key> (<name>) ✅" lines: the other device, called by its name. */
const syncedLines = (page: Page) => page.getByText(/^synced with \S{8} \(.+\) ✅$/);

async function syncNowFindsThePeerAgain(page: Page): Promise<void> {
	const synced = syncedLines(page);
	await expect(synced.first()).toBeVisible({ timeout: 90_000 });
	const before = await synced.count();

	await page.getByRole("button", { name: "Sync now" }).click();

	const marker = page.getByText("sync now: restarting").last();
	await expect(marker).toBeVisible();
	// A line from today carries the time alone.
	await expect(marker.locator("xpath=preceding-sibling::span[1]")).toHaveText(/^\d\d:\d\d:\d\d$/);
	await expect.poll(() => synced.count(), { timeout: 90_000 }).toBeGreaterThan(before);
	await expect(page.getByRole("button", { name: "Sync now" })).toBeEnabled();
}

test("Sync now finds the other device again, and the log names it", async ({ ext, mobile }) => {
	await pairWithPhone(ext, mobile);
	await expect(ext.page.getByText("Synced · 2 devices")).toBeVisible({ timeout: 90_000 });
	await syncNowFindsThePeerAgain(ext.page);

	await gotoSync(mobile.page);
	await syncNowFindsThePeerAgain(mobile.page);
});
