import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";
import { createVault, expectUnlocked, openPopup, optionsUrl } from "./helpers";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
	path.join(dir, "../../packages/platform-extension/src/fixtures/imports", name);

// Both KeePass paths, end to end through the real UI. Neither had an e2e despite the fixtures
// existing, which is how issues #78 and #79 both reached users: the parsers are unit-tested, but
// the .kdbx path only really runs when WASM derives the key from a file on disk, and the XML path
// only shows its entity handling once a value round-trips into the vault.
//
// Fixture passwords are "123456" (see the fixtures commit that repassworded them).
const PASSWORD = "123456";

/** Pick a provider card on the import screen and hand it a file. */
async function chooseProvider(page: import("@playwright/test").Page, label: RegExp, file: string) {
	const card = page.locator("label").filter({ hasText: label }).first();
	await expect(card).toBeVisible();
	await card.locator('input[type="file"]').setInputFiles(fixture(file));
	return card;
}

test("imports a KDBX4 database, deriving the key in WASM", async ({ context, extensionId }) => {
	const page = await context.newPage();
	await createVault(page, extensionId);
	await page.goto(`${optionsUrl(extensionId)}?screen=import`);

	await chooseProvider(page, /KeePass \(\.kdbx\)/, "kdbx4.kdbx");

	// The unlock step: a .kdbx is encrypted, so nothing can be previewed until it opens.
	await page
		.getByLabel(/password/i)
		.first()
		.fill(PASSWORD);
	await page.getByRole("button", { name: /Open database/i }).click();

	const importButton = page.getByRole("button", { name: /Import \d+ items?/i });
	await expect(importButton).toBeVisible({ timeout: 30_000 });
	await importButton.click();
	await expect(page.getByRole("heading", { name: /Imported \d+ items?/i })).toBeVisible();

	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);
	await expect(popup.getByText(/GitHub/i).first()).toBeVisible();
});

test("rejects a wrong master password with a specific message, not the generic one", async ({
	context,
	extensionId,
}) => {
	// Guards the KDBX_* code surviving the whole way out: Rust error -> code string -> the switch
	// in kdbx-error.ts. #78 was undiagnosable precisely because one code had no case there and
	// fell through to "Couldn't open this database."
	const page = await context.newPage();
	await createVault(page, extensionId);
	await page.goto(`${optionsUrl(extensionId)}?screen=import`);

	await chooseProvider(page, /KeePass \(\.kdbx\)/, "kdbx4.kdbx");
	await page
		.getByLabel(/password/i)
		.first()
		.fill("definitely-not-the-password");
	await page.getByRole("button", { name: /Open database/i }).click();

	await expect(page.getByText(/Wrong master password or key file/i)).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.getByText(/Couldn't open this database/i)).toHaveCount(0);
});

test("imports a KDBX4 database that needs a key file as well", async ({ context, extensionId }) => {
	const page = await context.newPage();
	await createVault(page, extensionId);
	await page.goto(`${optionsUrl(extensionId)}?screen=import`);

	await chooseProvider(page, /KeePass \(\.kdbx\)/, "kdbx4_with_keyfile.kdbx");

	await page
		.getByLabel(/password/i)
		.first()
		.fill(PASSWORD);
	// The key-file input is the second file input on the unlock step.
	await page.locator('input[type="file"]').last().setInputFiles(fixture("kdbx4_with_keyfile.keyx"));
	await page.getByRole("button", { name: /Open database/i }).click();

	const importButton = page.getByRole("button", { name: /Import \d+ items?/i });
	await expect(importButton).toBeVisible({ timeout: 30_000 });
	await importButton.click();
	await expect(page.getByRole("heading", { name: /Imported \d+ items?/i })).toBeVisible();
});

test("decodes XML entities from a KeePass XML export (#79)", async ({ context, extensionId }) => {
	const page = await context.newPage();
	await createVault(page, extensionId);
	await page.goto(`${optionsUrl(extensionId)}?screen=import`);

	await chooseProvider(page, /KeePass \(XML\)/, "keepass.xml");

	const importButton = page.getByRole("button", { name: /Import \d+ items?/i });
	await expect(importButton).toBeVisible();
	await importButton.click();
	await expect(page.getByRole("heading", { name: /Imported \d+ items?/i })).toBeVisible();

	// The fixture stores this password fully escaped. Reading it back from the vault is the only
	// place that proves the decode survived parse, mapping and write, rather than just the parser.
	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);
	await popup.getByLabel(/Search vault/i).fill("Amazon");
	await popup.getByText("Amazon").first().click();

	await popup.getByRole("button", { name: /Show password/i }).click();
	await expect(popup.getByText(`P@ssw&rd<1>"2"'3'&4`)).toBeVisible({ timeout: 10_000 });
});

// KeePassXC passkeys. Both fixtures hold the same credential with a throwaway Ed25519 key, which
// is what KeePassXC actually writes: it prefers EdDSA whenever a site offers it, so an ES256
// fixture would exercise a case few users have.
//
// Fixture provenance, since it is not obvious: `keepassxc-cli import` writes an AES-KDF database,
// which our reader refuses by design, so keepass-passkeys.kdbx was produced by Bramble's own
// KDBX exporter (Argon2id) from the same attributes as the .xml. KeePassXC opens it, which is
// the cross-check that it is a real KDBX4.
const PASSKEY_LABEL = /webauthn\.io \(Passkey\)/;

/** Open the first imported passkey entry in the popup and return its detail view. */
async function openPasskeyEntry(
	context: import("@playwright/test").BrowserContext,
	extensionId: string,
) {
	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);
	await popup.getByLabel(/Search vault/i).fill("webauthn");
	await popup.getByText(PASSKEY_LABEL).first().click();
	return popup;
}

for (const [label, file] of [
	["XML export", "keepass-passkeys.xml"],
	[".kdbx", "keepass-passkeys.kdbx"],
] as const) {
	test(`imports a KeePassXC passkey from a ${label}`, async ({ context, extensionId }) => {
		const page = await context.newPage();
		await createVault(page, extensionId);
		await page.goto(`${optionsUrl(extensionId)}?screen=import`);

		const provider = file.endsWith(".xml") ? /KeePass \(XML\)/ : /KeePass \(\.kdbx\)/;
		await chooseProvider(page, provider, file);
		if (!file.endsWith(".xml")) {
			await page
				.getByLabel(/password/i)
				.first()
				.fill(PASSWORD);
			await page.getByRole("button", { name: /Open database/i }).click();
		}

		// The preview counts passkeys generically, so this proves one was converted rather than
		// left as custom fields.
		await expect(page.getByText(/1 passkey/i)).toBeVisible({ timeout: 30_000 });
		await page.getByRole("button", { name: /Import \d+ items?/i }).click();
		await expect(page.getByRole("heading", { name: /Imported \d+ items?/i })).toBeVisible();

		const popup = await openPasskeyEntry(context, extensionId);
		// The badge keys off entry.passkeys, so seeing it means the credential is really stored.
		await expect(popup.getByLabel(/passkey/i).first()).toBeVisible();
		// And the raw attributes are gone: leaving them would keep a plaintext copy of the
		// private key in a custom field beside the credential that already holds it.
		await expect(popup.getByText(/KPEX_PASSKEY/)).toHaveCount(0);
	});
}

test("recognises the same passkey imported from the other container", async ({
	context,
	extensionId,
}) => {
	// De-duplication hashes the whole entry including its passkey, so this fails the moment the
	// XML and .kdbx paths stop producing identical bytes for one credential.
	const page = await context.newPage();
	await createVault(page, extensionId);

	await page.goto(`${optionsUrl(extensionId)}?screen=import`);
	await chooseProvider(page, /KeePass \(XML\)/, "keepass-passkeys.xml");
	await page.getByRole("button", { name: /Import \d+ items?/i }).click();
	await expect(page.getByRole("heading", { name: /Imported \d+ items?/i })).toBeVisible();

	await page.goto(`${optionsUrl(extensionId)}?screen=import`);
	await chooseProvider(page, /KeePass \(\.kdbx\)/, "keepass-passkeys.kdbx");
	await page
		.getByLabel(/password/i)
		.first()
		.fill(PASSWORD);
	await page.getByRole("button", { name: /Open database/i }).click();
	await expect(page.getByText(/already in your vault/i)).toBeVisible({ timeout: 30_000 });
});

test("imports a passkey from a database KeePassXC itself wrote", async ({
	context,
	extensionId,
}) => {
	// The fixtures above were written by Bramble's own KDBX exporter, so alone they cannot show
	// that we read a real KeePassXC file rather than one shaped the way we happen to write them.
	// This one is genuine KeePassXC 2.7.12 output: stock Argon2d benchmark settings (64 MiB, 106
	// rounds, which the pre-#78 ceiling rejected), a Recycle Bin copy that must be skipped, and an
	// Ed25519 passkey. See the README in the fixtures directory for why it is safe to commit.
	const page = await context.newPage();
	await createVault(page, extensionId);
	await page.goto(`${optionsUrl(extensionId)}?screen=import`);

	await chooseProvider(page, /KeePass \(\.kdbx\)/, "keepass-passkeys-real.kdbx");
	await page
		.getByLabel(/password/i)
		.first()
		.fill("qwerty");
	await page.getByRole("button", { name: /Open database/i }).click();

	// One entry, not two: the Recycle Bin holds a second copy that must not be imported.
	await expect(page.getByRole("button", { name: /Import 1 item/i })).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.getByText(/1 passkey/i)).toBeVisible();
	await page.getByRole("button", { name: /Import 1 item/i }).click();
	await expect(page.getByRole("heading", { name: /Imported 1 item/i })).toBeVisible();

	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);
	await popup.getByLabel(/Search vault/i).fill("webauthn");
	await popup
		.getByText(/webauthn\.io \(Passkey\)/)
		.first()
		.click();
	await expect(popup.getByText(/KPEX_PASSKEY/)).toHaveCount(0);
});
