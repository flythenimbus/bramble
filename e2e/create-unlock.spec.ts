import { expect, test } from "./fixtures";
import { createVault, expectUnlocked, lock, openPopup, unlock } from "./helpers";

// Increment 3: the common path through the real UI - create a vault, then lock and unlock it.
test("create a vault, then lock and unlock it", async ({ context, extensionId }) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);

	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	// Creation cached the VEK in session storage, so the popup opens unlocked.
	await expectUnlocked(popup);
	await expect(popup.getByText(/Your vault is empty/i)).toBeVisible();

	await lock(popup);
	// Wrong password is rejected.
	await popup.locator('input[type="password"]').first().fill("not-the-password");
	await popup.getByRole("button", { name: "Unlock Vault" }).click();
	await expect(popup.getByText(/Incorrect master password/i)).toBeVisible();

	// The real password unlocks.
	await unlock(popup);
});

// Regression: an unlocked vault must land on its home screen, not the vault picker. Creating a
// second vault leaves it active + unlocked, so a freshly opened popup opens straight on it.
test("a newly created second vault opens directly, not the picker", async ({
	context,
	extensionId,
}) => {
	const s1 = await context.newPage();
	await createVault(s1, extensionId);
	const s2 = await context.newPage();
	await createVault(s2, extensionId);

	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);
	await expect(popup.getByRole("heading", { name: /Choose a vault/i })).toHaveCount(0);
});
