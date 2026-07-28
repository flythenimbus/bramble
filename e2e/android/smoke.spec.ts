import { expect, test } from "./fixtures";

// Proves the CDP-over-adb harness reaches the shipped app: the WebView is attachable, the app's
// own UI renders, and Playwright can drive it. Read-only on purpose — it navigates but never
// creates, edits or deletes a vault, so it is safe to run against a device holding real data.
//
// The issue #27 repro (create a vault, delete it, unlock another) necessarily mutates vault state
// and lives in its own spec, so this one stays runnable anywhere.

test("attaches to the app's WebView on the device", async ({ page }) => {
	expect(page.url()).toMatch(/^https:\/\/localhost\//);
	await expect(page.locator("#root")).not.toBeEmpty();
	// The shipped app, not a dev server or a stale tab.
	expect(await page.title()).toBe("Bramble");
});

test("shows a locked vault and can reach the vault picker", async ({ page }) => {
	// Whatever screen the app was left on, get to one we can assert about.
	const picker = page.getByRole("heading", { name: /Choose a vault/i });
	const switchLink = page.getByRole("button", { name: /Choose a different vault/i });
	await expect(picker.or(switchLink)).toBeVisible();
	if (!(await picker.isVisible())) await switchLink.click();

	await expect(picker).toBeVisible();
	// At least one vault, and the affordance to add another — the surface the repro drives.
	await expect(page.getByRole("button", { name: /Create new vault/i })).toBeVisible();
});

test("the unlock screen offers the master-password field", async ({ page }) => {
	// Back out of the picker into a vault's unlock screen by choosing the first one.
	const picker = page.getByRole("heading", { name: /Choose a vault/i });
	if (await picker.isVisible()) {
		await page
			.getByRole("button", { name: /Vault /i })
			.first()
			.click();
	}

	// Present but never filled: this test does not attempt an unlock.
	await expect(page.locator('input[type="password"]').first()).toBeVisible();
});
