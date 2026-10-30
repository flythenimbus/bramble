import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";
import { createVault, expectUnlocked, openPopup, optionsUrl } from "./helpers";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
	path.join(dir, "../../clients/extension/src/fixtures/imports", name);

// The parser's own rules are unit-tested in roboform.test.ts. What is only reachable here is the
// whole path: the provider card, the file read, the preview's counts, and tags reaching the vault.
test("imports a RoboForm CSV export end to end", async ({ context, extensionId }) => {
	const page = await context.newPage();
	await createVault(page, extensionId);

	await page.goto(`${optionsUrl(extensionId)}?screen=import`);
	const card = page
		.locator("label")
		.filter({ hasText: /RoboForm/ })
		.first();
	await expect(card).toBeVisible();
	await card.locator('input[type="file"]').setInputFiles(fixture("roboform.csv"));

	// 5 rows in, 5 entries out: 3 logins, a bookmark and a safenote.
	await expect(page.getByRole("button", { name: /Import 5 items/i })).toBeVisible();
	await expect(
		page.getByText(/3 item\(s\) were in a RoboForm folder, imported as tags/i),
	).toBeVisible();

	await page.getByRole("button", { name: /Import 5 items/i }).click();
	await expect(page.getByRole("heading", { name: /Imported 5 items/i })).toBeVisible();

	// "/Dev/Hosting" is one folder two levels deep, so each level is its own tag.
	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);
	const search = popup.getByLabel(/Search vault/i);
	await search.fill("#dev");
	await expect(popup.getByText("Items (3)")).toBeVisible();
	await search.fill("#hosting");
	await expect(popup.getByText("Items (1)")).toBeVisible();
});

test("names RoboForm when its export is given to the Google card", async ({
	context,
	extensionId,
}) => {
	const page = await context.newPage();
	await createVault(page, extensionId);

	await page.goto(`${optionsUrl(extensionId)}?screen=import`);
	const card = page
		.locator("label")
		.filter({ hasText: /Google Password Manager/ })
		.first();
	await card.locator('input[type="file"]').setInputFiles(fixture("roboform.csv"));

	await expect(page.getByText(/looks like an export from RoboForm/i)).toBeVisible();
});
