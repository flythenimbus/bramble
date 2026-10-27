import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";
import { createVault, expectUnlocked, openPopup, optionsUrl } from "./helpers";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
	path.join(dir, "../../clients/extension/src/fixtures/imports", name);

// The parser's own rules are unit-tested in enpass.test.ts. What is only reachable here is the
// whole path: the provider card, the file read, the preview's counts and warnings, and tags
// reaching the vault.
test("imports an Enpass .json export end to end", async ({ context, extensionId }) => {
	const page = await context.newPage();
	await createVault(page, extensionId);

	await page.goto(`${optionsUrl(extensionId)}?screen=import`);
	const card = page
		.locator("label")
		.filter({ hasText: /Enpass/ })
		.first();
	await expect(card).toBeVisible();
	await card.locator('input[type="file"]').setInputFiles(fixture("enpass.json"));

	// 8 items in, 7 out: the trashed one is left out, and said to be.
	await expect(page.getByRole("button", { name: /Import 7 items/i })).toBeVisible();
	await expect(page.getByText(/1 item\(s\) in Enpass's trash were left out/i)).toBeVisible();
	await expect(page.getByText(/1 attachment\(s\) weren't imported/i)).toBeVisible();

	await page.getByRole("button", { name: /Import 7 items/i }).click();
	await expect(page.getByRole("heading", { name: /Imported 7 items/i })).toBeVisible();

	// Amazon sits in "Clients" under "Work", and Work mail in "Work" itself.
	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);
	const search = popup.getByLabel(/Search vault/i);
	await search.fill("#work");
	await expect(popup.getByText("Items (2)")).toBeVisible();
	await search.fill("#clients");
	await expect(popup.getByText("Items (1)")).toBeVisible();
});
