import { type BrowserContext, expect, type Page, type Worker } from "@playwright/test";

export const optionsUrl = (id: string) => `chrome-extension://${id}/options.html`;
export const popupUrl = (id: string) => `chrome-extension://${id}/popup.html`;

/** A strong master password that clears the weak-password gate (so "Create vault" enables). */
export const STRONG_PW = "Zx9-mQ2-vLp7-wK4-tR8";

/**
 * Create the first vault through the full-tab options setup flow (which the popup's "Create your
 * vault" opens). Leaves the vault created and unlocked. Pass through the recovery-code screen.
 */
export async function createVault(page: Page, extensionId: string, password = STRONG_PW) {
	await page.goto(optionsUrl(extensionId));
	await expect(page.locator("#root")).not.toBeEmpty();
	await page.locator('input[type="password"]').first().fill(password);
	await page.locator('input[type="password"]').nth(1).fill(password);
	await page.getByRole("button", { name: "Create vault" }).click();
	await page.getByRole("button", { name: /I've saved it/i }).click();
	await expect(page.getByRole("heading", { name: /Vault ready/i })).toBeVisible();
}

/** Open the popup UI and wait for the app to mount. */
export async function openPopup(page: Page, extensionId: string) {
	await page.goto(popupUrl(extensionId));
	await expect(page.locator("#root")).not.toBeEmpty();
}

/** True once the popup shows an unlocked vault (the header lock button is only present then). */
export async function expectUnlocked(page: Page) {
	await expect(page.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible();
}

/** Lock the unlocked popup via its header lock button; resolves on the unlock screen. */
export async function lock(page: Page) {
	await page.getByRole("button", { name: "Lock vault", exact: true }).click();
	await expect(page.getByRole("heading", { name: /master password to unlock/i })).toBeVisible();
}

/** Unlock the locked popup with the master password. */
export async function unlock(page: Page, password = STRONG_PW) {
	await page.locator('input[type="password"]').first().fill(password);
	await page.getByRole("button", { name: "Unlock Vault" }).click();
	await expectUnlocked(page);
}

/** Lock the popup and land on the vault picker. Locking keeps the vault selected, so it shows
 * that vault's unlock screen; follow "Choose a different vault" to reach the picker. */
export async function lockToPicker(page: Page) {
	await page.getByRole("button", { name: "Lock vault", exact: true }).click();
	const picker = page.getByRole("heading", { name: /Choose a vault/i });
	const switchLink = page.getByRole("button", { name: /Choose a different vault/i });
	await expect(picker.or(switchLink)).toBeVisible();
	if (!(await picker.isVisible())) await switchLink.click();
	await expect(picker).toBeVisible();
}

/** Pick a vault from the picker by its label, unlocking with the password if prompted. */
export async function selectVault(page: Page, name: RegExp, password = STRONG_PW) {
	await page.getByRole("button", { name }).click();
	const lockBtn = page.getByRole("button", { name: "Lock vault", exact: true });
	const pw = page.locator('input[type="password"]').first();
	// The app either opens the vault directly (its VEK is cached) or asks for the password.
	await expect(lockBtn.or(pw)).toBeVisible();
	if (!(await lockBtn.isVisible())) {
		await pw.fill(password);
		await page.getByRole("button", { name: "Unlock Vault" }).click();
	}
	await expectUnlocked(page);
}

/** From an unlocked popup, open Settings and select the Device sync panel. */
export async function gotoSync(page: Page) {
	await page.getByRole("button", { name: "Settings" }).click();
	await page.getByRole("button", { name: "Sync", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Device sync" })).toBeVisible();
}

/** The background service worker, for reading/writing the extension's storage in a test. */
export async function backgroundWorker(context: BrowserContext): Promise<Worker> {
	let [sw] = context.serviceWorkers();
	if (!sw) sw = await context.waitForEvent("serviceworker");
	return sw;
}

/** Every key in chrome.storage.local (the extension's persisted state). */
export async function localStorageKeys(context: BrowserContext): Promise<string[]> {
	const sw = await backgroundWorker(context);
	return sw.evaluate(async () => Object.keys(await chrome.storage.local.get(null)));
}
