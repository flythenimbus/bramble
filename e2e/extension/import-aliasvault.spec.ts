import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";
import { createVault, expectUnlocked, openPopup, optionsUrl } from "./helpers";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
	path.join(dir, "../../clients/extension/src/fixtures/imports", name);

// The parser's own rules are unit-tested in aliasvault.test.ts. What is only reachable here is the
// whole path: the provider card, the file read, the preview's counts, and tags reaching the vault.
test("imports an AliasVault CSV export end to end", async ({ context, extensionId }) => {
	const page = await context.newPage();
	await createVault(page, extensionId);

	await page.goto(`${optionsUrl(extensionId)}?screen=import`);
	const card = page
		.locator("label")
		.filter({ hasText: /AliasVault/ })
		.first();
	await expect(card).toBeVisible();
	await card.locator('input[type="file"]').setInputFiles(fixture("aliasvault.csv"));

	// 5 rows in, 5 entries out: 3 logins, a card and a note.
	await expect(page.getByRole("button", { name: /Import 5 items/i })).toBeVisible();
	await expect(
		page.getByText(/2 item\(s\) were in an AliasVault folder, imported as tags/i),
	).toBeVisible();

	await page.getByRole("button", { name: /Import 5 items/i }).click();
	await expect(page.getByRole("heading", { name: /Imported 5 items/i })).toBeVisible();

	// "Personal/Email" is one folder two levels deep, so each level is its own tag.
	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);
	const search = popup.getByLabel(/Search vault/i);
	await search.fill("#personal");
	await expect(popup.getByText("Items (1)")).toBeVisible();
	await search.fill("#email");
	await expect(popup.getByText("Items (1)")).toBeVisible();
});

test("names AliasVault when its export is given to the LastPass card", async ({
	context,
	extensionId,
}) => {
	const page = await context.newPage();
	await createVault(page, extensionId);

	await page.goto(`${optionsUrl(extensionId)}?screen=import`);
	const card = page
		.locator("label")
		.filter({ hasText: /LastPass/ })
		.first();
	await card.locator('input[type="file"]').setInputFiles(fixture("aliasvault.csv"));

	await expect(page.getByText(/looks like an export from AliasVault/i)).toBeVisible();
});
