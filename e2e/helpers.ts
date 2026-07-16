import { expect, type Page } from "@playwright/test";

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
	await expect(page.getByRole("button", { name: "Lock vault" })).toBeVisible();
}

/** Lock the unlocked popup via its header lock button; resolves on the unlock screen. */
export async function lock(page: Page) {
	await page.getByRole("button", { name: "Lock vault" }).click();
	await expect(page.getByRole("heading", { name: /master password to unlock/i })).toBeVisible();
}

/** Unlock the locked popup with the master password. */
export async function unlock(page: Page, password = STRONG_PW) {
	await page.locator('input[type="password"]').first().fill(password);
	await page.getByRole("button", { name: "Unlock Vault" }).click();
	await expectUnlocked(page);
}
