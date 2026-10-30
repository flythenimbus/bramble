import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";
import { createVault, expectUnlocked, openPopup, optionsUrl } from "./helpers";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
	path.join(dir, "../../clients/extension/src/fixtures/imports", name);

// The parser's own rules are unit-tested in dashlane.test.ts. What is only reachable here is the
// whole path: the provider card, the zip read as bytes, the preview's counts, and tags reaching
// the vault.
test("imports a Dashlane CSV export end to end", async ({ context, extensionId }) => {
	const page = await context.newPage();
	await createVault(page, extensionId);

	await page.goto(`${optionsUrl(extensionId)}?screen=import`);
	const card = page
		.locator("label")
		.filter({ hasText: /Dashlane/ })
		.first();
	await expect(card).toBeVisible();
	await card.locator('input[type="file"]').setInputFiles(fixture("dashlane.zip"));

	// 9 rows across five files: 2 logins, a card, and 6 notes (a secure note, a bank account, a
	// licence, a passport, a name and an email).
	await expect(page.getByRole("button", { name: /Import 9 items/i })).toBeVisible();
	await expect(
		page.getByText(/2 item\(s\) had a Dashlane category, imported as tags/i),
	).toBeVisible();

	await page.getByRole("button", { name: /Import 9 items/i }).click();
	await expect(page.getByRole("heading", { name: /Imported 9 items/i })).toBeVisible();

	// "Personal, Shopping" is one item in two collections, so each is its own tag.
	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);
	const search = popup.getByLabel(/Search vault/i);
	await search.fill("#shopping");
	await expect(popup.getByText("Items (1)")).toBeVisible();
	await search.fill("#dev");
	await expect(popup.getByText("Items (1)")).toBeVisible();
});
