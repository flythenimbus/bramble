import type { Page } from "@playwright/test";
import { unlock } from "../extension/helpers";
import { addLogin, EDIT_WITHIN_MS, expect, PW, pairWithPhone, test } from "./fixtures";

// Peers no longer resend an unchanged vault every tick (docs/sync-rebroadcast.md), which used to
// settle these cases on its own. What makes them settle now: a merge that changes a device's vault
// is a change it sends on, and every connection starts with a whole envelope each way.

/** Open a login's detail view and its edit form. */
async function edit(page: Page, name: string): Promise<void> {
	await page.getByText(name).click();
	await page.getByRole("button", { name: "Edit entry" }).click();
}

const FROM_BROWSER = "from-browser@example.com";
const FROM_PHONE = "from-phone@example.com";

/** Which of the two edits a device's detail view shows. */
async function shown(page: Page): Promise<string> {
	const browser = await page.getByText(FROM_BROWSER).isVisible();
	const phone = await page.getByText(FROM_PHONE).isVisible();
	return browser === phone ? (browser ? "both" : "neither") : browser ? FROM_BROWSER : FROM_PHONE;
}

test("the same entry edited on both devices at once ends up the same on both", async ({
	ext,
	mobile,
}) => {
	const popup = await pairWithPhone(ext, mobile);
	await addLogin(popup, "Shared login");
	await expect(mobile.page.getByText("Shared login")).toBeVisible({ timeout: EDIT_WITHIN_MS });
	await popup.waitForTimeout(6_000);

	await edit(popup, "Shared login");
	await edit(mobile.page, "Shared login");
	await popup.getByLabel(/Username or email/i).fill(FROM_BROWSER);
	await mobile.page.getByLabel(/Username or email/i).fill(FROM_PHONE);
	await Promise.all([
		popup.getByRole("button", { name: /Update Login/i }).click(),
		mobile.page.getByRole("button", { name: /Update Login/i }).click(),
	]);

	// Each device starts with its own edit; within a few ticks both show the same one.
	await expect(async () => {
		const onBrowser = await shown(popup);
		expect([FROM_BROWSER, FROM_PHONE]).toContain(onBrowser);
		expect(await shown(mobile.page)).toBe(onBrowser);
	}).toPass({ timeout: 30_000 });
	const settled = await shown(popup);
	console.log(`[e2e] both devices settled on ${settled}`);
	// And stays settled: no flip-flopping once nothing is resent.
	await popup.waitForTimeout(15_000);
	expect(await shown(popup)).toBe(settled);
	expect(await shown(mobile.page)).toBe(settled);
});

test("a device that was away gets what changed meanwhile, either way", async ({ ext, mobile }) => {
	const popup = await pairWithPhone(ext, mobile);
	await popup.waitForTimeout(6_000);

	// The phone leaves, taking its sync with it, while the browser edits.
	const app = mobile.page.url();
	await mobile.page.goto("about:blank");
	await addLogin(popup, "Added while the phone was away");
	await popup.waitForTimeout(10_000);
	await mobile.page.goto(app);
	await unlock(mobile.page, PW);
	await expect(mobile.page.getByText("Added while the phone was away")).toBeVisible({
		timeout: EDIT_WITHIN_MS,
	});

	// The browser locks, which stops its sync, while the phone edits.
	await popup.getByRole("button", { name: "Lock vault", exact: true }).click();
	await addLogin(mobile.page, "Added while the browser was locked");
	await popup.waitForTimeout(10_000);
	await unlock(popup, PW);
	await expect(popup.getByText("Added while the browser was locked")).toBeVisible({
		timeout: EDIT_WITHIN_MS,
	});
});
