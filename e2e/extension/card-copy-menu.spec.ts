import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createVault, openPopup, seedExampleCard } from "./helpers";

// The vault list's copy menu for a card row. The projection that builds these items is unit-tested
// in list-item.test.ts; this covers the seam through to what a user actually sees, which is where
// the menu previously offered the card number alone.

/** The list row for `name`, hovered so its hidden action buttons are interactive. */
async function cardRow(popup: Page, name: string) {
	const row = popup.getByText(name).locator("xpath=ancestor::*[contains(@class,'group')][1]");
	await row.hover();
	return row;
}

test("a card row offers number, expiry and CVV", async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleCard(popup);

	const row = await cardRow(popup, "Personal Visa");
	await row.getByRole("button", { name: "Copy", exact: true }).click();

	await expect(popup.getByRole("button", { name: /^Copy / })).toHaveText([
		"Copy card number",
		"Copy expiry",
		"Copy CVV",
	]);
});

test("copying the CVV from the list confirms on the row", async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleCard(popup);

	const row = await cardRow(popup, "Personal Visa");
	await row.getByRole("button", { name: "Copy", exact: true }).click();
	await popup.getByRole("button", { name: "Copy CVV" }).click();

	// The trigger reports what it copied, which is the only feedback the row gives.
	await expect(row.getByRole("button", { name: /Copied CVV/i })).toBeVisible({ timeout: 10_000 });
});

test("omits the rows a card has no value for", async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);

	// A card with only a number: no expiry, no CVV, so neither may appear.
	await popup.getByRole("button", { name: /Add New/i }).click();
	await popup.getByRole("button", { name: /Payment card/i }).click();
	await popup.getByLabel("Name", { exact: true }).fill("Number only");
	await popup.getByLabel("Card number", { exact: true }).fill("4242424242424242");
	await popup.getByRole("button", { name: /^Save/i }).click();
	await expect(popup.getByText("Number only")).toBeVisible();

	const row = await cardRow(popup, "Number only");
	await row.getByRole("button", { name: "Copy", exact: true }).click();

	await expect(popup.getByRole("button", { name: /^Copy / })).toHaveText(["Copy card number"]);
});
