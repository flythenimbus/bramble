import { expect, test } from "./fixtures";
import { expectUnlocked, lock, openPopup, optionsUrl, STRONG_PW, unlock } from "./helpers";

const NEW_PW = "Qp4-nH8-sWd2-yT6-kM3";

// A forgotten master password: unlock with the recovery code, land on the master password in
// Settings, change it by proving the code again, and be offered (not forced) a new code.
test("a recovery-code unlock leads to setting a new master password", async ({
	context,
	extensionId,
}) => {
	const setup = await context.newPage();
	await setup.goto(optionsUrl(extensionId));
	await expect(setup.locator("#root")).not.toBeEmpty();
	await setup.locator('input[type="password"]').first().fill(STRONG_PW);
	await setup.locator('input[type="password"]').nth(1).fill(STRONG_PW);
	await setup.getByRole("button", { name: "Create vault" }).click();
	const code = (await setup.locator("code").textContent())?.trim() ?? "";
	expect(code).not.toBe("");
	await setup.getByRole("button", { name: /I've saved it/i }).click();

	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);
	await lock(popup);

	const unlockWithCode = async () => {
		await popup.getByRole("button", { name: "Unlock with recovery code" }).click();
		await popup.getByLabel("Recovery code").fill(code);
		await popup.getByRole("button", { name: "Unlock", exact: true }).click();
		await expectUnlocked(popup);
	};
	await unlockWithCode();

	await expect(popup.getByText(/You unlocked with your recovery code/)).toBeVisible();
	await popup.getByRole("button", { name: "Change", exact: true }).click();
	await popup.getByLabel("Current recovery code").fill(code);
	await popup.getByLabel("New password", { exact: true }).fill(NEW_PW);
	await popup.getByLabel("Confirm new password").fill(NEW_PW);
	await popup.getByRole("button", { name: "Update password" }).click();
	await expect(popup.getByText("Master password updated.")).toBeVisible();
	await expect(popup.getByText(/You used your recovery code/)).toBeVisible();

	// The new password unlocks, and the old code still works until the user resets it.
	await lock(popup);
	await unlock(popup, NEW_PW);
	await lock(popup);
	await unlockWithCode();
});
