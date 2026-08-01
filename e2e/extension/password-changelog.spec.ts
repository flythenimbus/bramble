import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createVault, openPopup, seedExampleLogin } from "./helpers";

// The password changelog end to end through the real UI: rotate a login in the edit form and the
// superseded password must be readable (and copyable) from the detail view, which is the whole
// point of the feature — an IdP that hasn't propagated the new password yet still wants the old
// one. See docs/password-changelog.md.

const ORIGINAL_PW = "s3cr3t-pw-01";

/** Open the seeded login's detail view from the vault list. */
async function openExampleLogin(popup: Page) {
	await popup.getByText("Example Login").click();
	await expect(popup.getByRole("button", { name: "Edit entry" })).toBeVisible();
}

/** Rotate the open entry's password through the edit form, returning to the detail view. */
async function rotatePassword(popup: Page, next: string) {
	await popup.getByRole("button", { name: "Edit entry" }).click();
	await popup.getByLabel("Password", { exact: true }).fill(next);
	await popup.getByRole("button", { name: /Update Login/i }).click();
	await expect(popup.getByRole("button", { name: "Edit entry" })).toBeVisible();
}

test("a rotation records the superseded password, revealable from the detail view", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);

	await openExampleLogin(popup);
	// A login that has never been rotated shows no changelog at all.
	await expect(popup.getByRole("button", { name: /Password changed/ })).toHaveCount(0);

	await rotatePassword(popup, "n3w-pw-02");

	// The footnote appears under the password field, timestamped.
	const toggle = popup.getByRole("button", { name: /Password changed/ });
	await expect(toggle).toBeVisible();
	await expect(toggle).toHaveAttribute("aria-expanded", "false");

	// Expanding reveals one row, masked by default.
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	const reveal = popup.getByRole("button", { name: "Show previous password" });
	await expect(reveal).toHaveCount(1);
	await expect(popup.getByText(ORIGINAL_PW)).toHaveCount(0);

	// Revealing shows the actual superseded value, which is what gets you back in.
	await reveal.click();
	await expect(popup.getByText(ORIGINAL_PW)).toBeVisible();
	await expect(popup.getByRole("button", { name: "Hide previous password" })).toBeVisible();
});

test("keeps rotations seconds apart as separate, individually timestamped rows", async ({
	context,
	extensionId,
}) => {
	// The reported scenario: rotate, the change doesn't propagate, rotate again moments later.
	// Both superseded values must survive as distinct rows.
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);

	await openExampleLogin(popup);
	await rotatePassword(popup, "n3w-pw-02");
	await rotatePassword(popup, "n3w-pw-03");

	await popup.getByRole("button", { name: /Password changed/ }).click();
	// Newest first: the value replaced most recently leads. Revealing a row flips its button
	// to "Hide", so the still-hidden rows are always what `first()` resolves to.
	const hidden = popup.getByRole("button", { name: "Show previous password" });
	await expect(hidden).toHaveCount(2);
	await hidden.first().click();
	await expect(popup.getByText("n3w-pw-02")).toBeVisible();
	await hidden.first().click();
	await expect(popup.getByText(ORIGINAL_PW)).toBeVisible();
});

test("an edit that leaves the password alone records nothing", async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);

	await openExampleLogin(popup);
	await popup.getByRole("button", { name: "Edit entry" }).click();
	await popup.getByLabel("Name", { exact: true }).fill("Example Login renamed");
	await popup.getByRole("button", { name: /Update Login/i }).click();
	await expect(popup.getByRole("button", { name: "Edit entry" })).toBeVisible();

	await expect(popup.getByRole("button", { name: /Password changed/ })).toHaveCount(0);
});

test("an unrelated edit after a rotation keeps the changelog the form never carried", async ({
	context,
	extensionId,
}) => {
	// The edit form rebuilds an entry from its own fields and has no changelog input, so this is
	// the regression that would silently wipe the log if the mutation seam did not own the field.
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);

	await openExampleLogin(popup);
	await rotatePassword(popup, "n3w-pw-02");

	await popup.getByRole("button", { name: "Edit entry" }).click();
	await popup.getByLabel("Name", { exact: true }).fill("Example Login renamed");
	await popup.getByRole("button", { name: /Update Login/i }).click();
	await expect(popup.getByRole("button", { name: "Edit entry" })).toBeVisible();

	await popup.getByRole("button", { name: /Password changed/ }).click();
	await popup.getByRole("button", { name: "Show previous password" }).click();
	await expect(popup.getByText(ORIGINAL_PW)).toBeVisible();
});

test("the detail view surfaces created and updated timestamps", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);

	await openExampleLogin(popup);
	await expect(popup.getByText(/^Created /)).toBeVisible();
	await expect(popup.getByText(/^Updated /)).toBeVisible();
});
