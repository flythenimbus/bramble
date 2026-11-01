import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";
import { createVault, openPopup, optionsUrl } from "./helpers";

const dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(
	dir,
	"../../clients/extension/src/fixtures/imports/protonpass-passkeys.zip",
);

// The unit tests convert Proton's passkey with a WebCrypto stand-in. Only this reaches the real
// crypto core, which has to accept the scalar-only PKCS#8 we build from Proton's COSE key.
test("imports a Proton Pass passkey end to end", async ({ context, extensionId }) => {
	const page = await context.newPage();
	await createVault(page, extensionId);

	await page.goto(`${optionsUrl(extensionId)}?screen=import`);
	const card = page
		.locator("label")
		.filter({ hasText: /Proton Pass/ })
		.first();
	await expect(card).toBeVisible();
	await card.locator('input[type="file"]').setInputFiles(FIXTURE);

	await expect(page.getByRole("button", { name: /Import 2 items/i })).toBeVisible();
	await expect(page.getByText(/was skipped|can't be imported/i)).toHaveCount(0);
	await page.getByRole("button", { name: /Import 2 items/i }).click();
	await expect(page.getByRole("heading", { name: /Imported 2 items/i })).toBeVisible();

	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	const withPasskey = popup
		.locator("div")
		.filter({ hasText: /^webauthn\.io/ })
		.first();
	await expect(withPasskey.getByLabel(/Holds a passkey/i)).toBeVisible();
});
