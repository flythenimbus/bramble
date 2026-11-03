import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";
import { createVault, downloadAttachment, expectUnlocked, optionsUrl, popupUrl } from "./helpers";

const dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(dir, "../../clients/extension/src/fixtures/imports/protonpass-files.zip");

// Proton names each file with a hash of its vault and file ids; the parser is unit-tested, but
// only this shows the files sealed onto their logins under the names they had in Proton.
test("imports a Proton Pass export's files and every website", async ({ context, extensionId }) => {
	const page = await context.newPage();
	await createVault(page, extensionId);

	await page.goto(`${optionsUrl(extensionId)}?screen=import`);
	const card = page
		.locator("label")
		.filter({ hasText: /Proton Pass/ })
		.first();
	await card.locator('input[type="file"]').setInputFiles(FIXTURE);
	await expect(page.getByText(/2 attachments go with them/i)).toBeVisible();
	await expect(page.getByText(/1 website\(s\) were set to never autofill/i)).toBeVisible();
	await page.getByRole("button", { name: /Import 2 items/i }).click();
	await expect(page.getByText(/2 attachments came with them/i)).toBeVisible();

	const popup = await context.newPage();
	await popup.goto(`${popupUrl(extensionId)}?detached=1`);
	await expectUnlocked(popup);
	expect((await downloadAttachment(popup, "Test", "sample.pdf")).toString()).toBe(
		"fake sample pdf",
	);
	expect((await downloadAttachment(popup, "youtube.com", "README")).toString()).toBe("fake readme");
});
