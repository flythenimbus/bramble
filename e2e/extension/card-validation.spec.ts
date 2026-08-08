import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createVault, openPopup } from "./helpers";

// Card number validation in the entry form. The rules live in a zod schema
// (util/card.ts) and are unit-tested there; this covers that a bad number actually
// blocks the save and shows why, which a schema test cannot tell you.

async function openCardForm(popup: Page) {
	await popup.getByRole("button", { name: /Add New/i }).click();
	await popup.getByRole("button", { name: /Payment card/i }).click();
	await popup.getByLabel("Name", { exact: true }).fill("Test card");
}

async function fillNumberAndSave(popup: Page, number: string) {
	await popup.getByLabel("Card number", { exact: true }).fill(number);
	await popup.getByRole("button", { name: /^Save/i }).click();
}

test("refuses a number with too many digits for its brand", async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await openCardForm(popup);

	// 17 digits on a Visa prefix: the case that prompted this.
	await fillNumberAndSave(popup, "42424242424242424");

	await expect(popup.getByText(/right number of digits/i)).toBeVisible();
	// Still on the form, nothing saved.
	await expect(popup.getByLabel("Card number", { exact: true })).toBeVisible();
});

test("refuses a number that fails the checksum", async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await openCardForm(popup);

	await fillNumberAndSave(popup, "4242424242424243");

	await expect(popup.getByText(/isn't a valid card number/i)).toBeVisible();
});

test("refuses letters in the number", async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await openCardForm(popup);

	await fillNumberAndSave(popup, "4242 4242 4242 424a");

	await expect(popup.getByText(/only digits, spaces or dashes/i)).toBeVisible();
});

test("caps the field so extra digits cannot be typed at all", async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await openCardForm(popup);

	const field = popup.getByLabel("Card number", { exact: true });
	await field.fill("");
	await field.pressSequentially("4242424242424242424242424242");

	// 19 digits plus separators is the longest a card can be written as.
	expect((await field.inputValue()).length).toBeLessThanOrEqual(23);
});

test("saves a valid grouped number, and clears the error once corrected", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await openCardForm(popup);

	// Start wrong so the error is showing...
	await fillNumberAndSave(popup, "4242424242424243");
	await expect(popup.getByText(/isn't a valid card number/i)).toBeVisible();

	// ...then correct it, with the spaces people actually paste.
	await fillNumberAndSave(popup, "4242 4242 4242 4242");

	await expect(popup.getByText("Test card")).toBeVisible();
	await expect(popup.getByText(/isn't a valid card number/i)).toHaveCount(0);
});

test("still allows a card saved without a number", async ({ context, extensionId }) => {
	// Emptiness is the form's call, not the schema's: a card entry with only a name
	// and an expiry stays savable.
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await openCardForm(popup);

	await popup.getByRole("button", { name: /^Save/i }).click();

	await expect(popup.getByText("Test card")).toBeVisible();
});
