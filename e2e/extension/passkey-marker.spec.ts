import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";
import { createVault, openPopup, optionsUrl } from "./helpers";

const dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(
	dir,
	"../../packages/platform-extension/src/fixtures/imports/bitwarden-passkeys.json",
);

// The marker exists so someone cleaning up duplicated entries can see which copy holds a
// passkey without opening each one; deleting a login deletes its passkeys with it.
//
// This is an e2e rather than a component test because the bug it guards against was in the
// SEAM: the row rendered the marker correctly all along, while the list projection dropped the
// field before it arrived. Only a test that spans both catches that.
test("the vault list marks logins that hold a passkey", async ({ context, extensionId }) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);

	await setup.goto(`${optionsUrl(extensionId)}?screen=import`);
	const card = setup
		.locator("label")
		.filter({ hasText: /Bitwarden/ })
		.first();
	await expect(card).toBeVisible();
	await card.locator('input[type="file"]').setInputFiles(FIXTURE);
	await setup.getByRole("button", { name: /Import 7 items/i }).click();
	await expect(setup.getByRole("heading", { name: /Imported 7 items/i })).toBeVisible();

	const popup = await context.newPage();
	await openPopup(popup, extensionId);

	// webauthn.io carries one passkey in the fixture; Reddit is a plain login.
	const withPasskey = popup
		.locator("div")
		.filter({ hasText: /^webauthn\.io/ })
		.first();
	await expect(withPasskey.getByLabel(/Holds a passkey/i)).toBeVisible();

	const without = popup
		.locator("div")
		.filter({ hasText: /^Reddit/ })
		.first();
	await expect(without.getByLabel(/Holds/i)).toHaveCount(0);
});
