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
	// The unlock screen names the vault it's unlocking, in the top-left.
	await expect(popup.getByTestId("active-vault-label")).toHaveText("Vault 1");
	// Wrong password is rejected.
	await popup.locator('input[type="password"]').first().fill("not-the-password");
	await popup.getByRole("button", { name: "Unlock Vault" }).click();
	await expect(popup.getByText(/Incorrect master password/i)).toBeVisible();

	// The real password unlocks, and the header names the (only) vault.
	await unlock(popup);
	await expect(popup.getByTestId("active-vault-label")).toHaveText("Vault 1");
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
	// The header names the open vault when more than one exists (the second is "Vault 2").
	await expect(popup.getByTestId("active-vault-label")).toHaveText("Vault 2");
});

// The outlined TextField draws its border with a fieldset/legend, so the label gap is a real
// notch. The notch used to key off the group's :focus-within while the label keyed off the
// input, and the password reveal button lives in that same group - so focusing the eye notched
// the border open with no label in it (a visible cut in the border). Both must agree.
test("the reveal button doesn't leave a gap in the master-password border", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await lock(popup);

	// notch open <-> label floated, read off real layout (CSS-driven, so jsdom can't see it).
	const state = () =>
		popup.evaluate(() => {
			const input = document.querySelector<HTMLInputElement>(
				'input[type="password"], input[type="text"]',
			);
			const group = input?.closest(".group") as HTMLElement;
			const legend = group.querySelector("legend") as HTMLElement;
			const label = group.querySelector("label") as HTMLElement;
			return {
				notchOpen: legend.getBoundingClientRect().width > 4,
				labelFloated:
					Math.abs(label.getBoundingClientRect().top - group.getBoundingClientRect().top) < 8,
			};
		});

	// Poll: the label/notch animate (150ms), so assert the settled state.
	await popup.locator('input[type="password"]').first().click();
	await expect.poll(state).toEqual({ notchOpen: true, labelFloated: true });

	// Focus moves to the eye, off the (empty) input: the notch must close with the label.
	await popup.getByRole("button", { name: /Show password/i }).click();
	await expect.poll(state).toEqual({ notchOpen: false, labelFloated: false });

	// With a value, both stay on even while the eye holds focus.
	await popup.locator('input[type="text"], input[type="password"]').first().fill("hunter2");
	await popup
		.getByRole("button", { name: /password/i })
		.first()
		.click();
	expect(await state()).toEqual({ notchOpen: true, labelFloated: true });
});
