import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";
import { createVault, downloadAttachment, expectUnlocked, optionsUrl, popupUrl } from "./helpers";

const dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(
	dir,
	"../../clients/extension/src/fixtures/imports/onepassword-files.1pux",
);

// A 1Password export carries its files beside export.data: the parser is unit-tested, but only
// this shows them sealed onto the entries and opened again. Bank's statement is on a field,
// Passport is a Document item.
test("imports a 1Password export's files onto the items that hold them", async ({
	context,
	extensionId,
}) => {
	const page = await context.newPage();
	await createVault(page, extensionId);

	await page.goto(`${optionsUrl(extensionId)}?screen=import`);
	const card = page
		.locator("label")
		.filter({ hasText: /1Password/ })
		.first();
	await card.locator('input[type="file"]').setInputFiles(FIXTURE);
	await expect(page.getByText(/· 2 attachments$/)).toBeVisible();
	await page.getByRole("button", { name: /Import 2 items/i }).click();
	await expect(page.getByText(/2 attachments came with them/i)).toBeVisible();

	const popup = await context.newPage();
	await popup.goto(`${popupUrl(extensionId)}?detached=1`);
	await expectUnlocked(popup);
	expect((await downloadAttachment(popup, "Bank", "statement.pdf")).toString()).toBe(
		"fake bank statement",
	);
	expect((await downloadAttachment(popup, "Passport", "passport-scan.png")).toString()).toBe(
		"fake passport scan",
	);
});
