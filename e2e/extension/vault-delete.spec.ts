import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
	createVault,
	lockToPicker,
	openPopup,
	STRONG_PW,
	selectVault,
	waitOutPickerClickGuard,
} from "./helpers";

async function deleteOpenVault(popup: Page) {
	await popup.getByRole("button", { name: "Settings" }).click();
	await popup.getByRole("button", { name: "Delete this vault" }).click();
	await popup.getByLabel("Master password").fill(STRONG_PW);
	await popup.getByRole("button", { name: "Delete this vault" }).click();
	await expect(popup.getByRole("heading", { name: /Choose a vault/i })).toBeVisible();
}

// Unnamed vaults were numbered by their place on the list, so deleting Vault 1 relabelled the
// others Vault 1 and Vault 2: the deleted name stayed and the last vault seemed to go.
test("a deleted vault's name leaves the picker, and the rest keep theirs", async ({
	context,
	extensionId,
}) => {
	for (let i = 0; i < 3; i++) await createVault(await context.newPage(), extensionId);

	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await lockToPicker(popup);
	await waitOutPickerClickGuard(popup);
	await selectVault(popup, /Vault 1/);
	await deleteOpenVault(popup);

	const rows = popup.getByRole("button", { name: /^V\d\s*Vault \d/ });
	await expect(rows).toHaveCount(2);
	await expect(rows.nth(0)).toContainText("Vault 2");
	await expect(rows.nth(1)).toContainText("Vault 3");

	const reopened = await context.newPage();
	await openPopup(reopened, extensionId);
	await expect(reopened.getByRole("button", { name: /Vault 1/ })).toHaveCount(0);
	await expect(reopened.getByRole("button", { name: /Vault 2/ })).toBeVisible();
	await expect(reopened.getByRole("button", { name: /Vault 3/ })).toBeVisible();
});
