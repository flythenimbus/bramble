import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";
import { createVault, expectUnlocked, openPopup, optionsUrl } from "./helpers";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
	path.join(dir, "../../packages/platform-extension/src/fixtures/imports", name);

// The parser's own rules are unit-tested in lastpass.test.ts. What is only reachable here is the
// whole path: the provider card the import screen builds from IMPORT_PROVIDERS, the file read,
// and the counts the preview shows before anything is written.
test("imports a full LastPass export end to end", async ({ context, extensionId }) => {
	const page = await context.newPage();
	await createVault(page, extensionId);

	await page.goto(`${optionsUrl(extensionId)}?screen=import`);
	const card = page
		.locator("label")
		.filter({ hasText: /LastPass/ })
		.first();
	await expect(card).toBeVisible();
	await card.locator('input[type="file"]').setInputFiles(fixture("lastpass.csv"));

	// 30 rows in, 30 entries out: 9 logins, 17 notes, 3 cards and an SSH key.
	await expect(page.getByRole("button", { name: /Import 30 items/i })).toBeVisible();
	// 27 of the 30 rows carry a `grouping`, which now becomes tags rather than a custom
	// field named "Folder". Counted, never silent.
	await expect(
		page.getByText(/27 item\(s\) were in a LastPass folder, imported as tags/i),
	).toBeVisible();

	await page.getByRole("button", { name: /Import 30 items/i }).click();
	await expect(page.getByRole("heading", { name: /Imported 30 items/i })).toBeVisible();

	// The point of the mapping is that tags reach the VAULT, not just the parser, so this
	// checks the list rather than the preview. The fixture nests one row under
	// "Dev\\Hosting", so #hosting proves the per-level split survived the write too.
	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);
	const search = popup.getByLabel(/Search vault/i);
	await search.fill("#dev");
	await expect(popup.getByText("Items (5)")).toBeVisible();
	await search.fill("#hosting");
	await expect(popup.getByText("Items (1)")).toBeVisible();
});

test("imports a pre-TOTP export, whose columns sit one to the left", async ({
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
	await card.locator('input[type="file"]').setInputFiles(fixture("lastpass-legacy.csv"));

	await expect(page.getByRole("button", { name: /Import 9 items/i })).toBeVisible();
});

// A LastPass header carries name+url+username+password, so it used to pass as a Google export and
// import wrongly in silence. The user has to be told which card to pick instead.
test("names LastPass when its export is given to the Google card", async ({
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
	await card.locator('input[type="file"]').setInputFiles(fixture("lastpass.csv"));

	await expect(page.getByText(/looks like an export from LastPass/i)).toBeVisible();
});
