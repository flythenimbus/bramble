import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createVault, optionsUrl } from "./helpers";

const dir = path.dirname(fileURLToPath(import.meta.url));
const BITWARDEN_FIXTURE = path.join(
	dir,
	"../../packages/platform-extension/src/fixtures/imports/bitwarden.json",
);

/** Pick the Bitwarden card on the import screen and hand it the fixture. */
async function pickBitwarden(page: Page, extensionId: string) {
	await page.goto(`${optionsUrl(extensionId)}?screen=import`);
	const card = page
		.locator("label")
		.filter({ hasText: /Bitwarden/ })
		.first();
	await expect(card).toBeVisible();
	await card.locator('input[type="file"]').setInputFiles(BITWARDEN_FIXTURE);
}

// github issue #39: importing the same file twice used to double every entry, because every
// importer appended unconditionally. The vault is the thing that has to notice, so this is an
// e2e rather than a unit test: the preview has to reflect it BEFORE the write.
test("re-importing the same file adds nothing and says so", async ({ context, extensionId }) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);

	const first = await context.newPage();
	await pickBitwarden(first, extensionId);
	await first.getByRole("button", { name: /Import 5 items/i }).click();
	await expect(first.getByRole("heading", { name: /Imported 5 items/i })).toBeVisible();

	// Same file again: nothing new, and the reason is stated rather than a preview of zero items.
	const second = await context.newPage();
	await pickBitwarden(second, extensionId);
	await expect(second.getByText(/already in your vault/i)).toBeVisible();
	await expect(second.getByText(/items ready to import/i)).toBeHidden();
});

// The mixed case (some new, some already held, and the "N more were already in your vault"
// count) is covered by splitAlreadyImported's unit tests. Reaching it here would mean deleting
// an entry through the UI first, and no other spec has that choreography to borrow.
