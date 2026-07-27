import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createVault, openPopup, optionsUrl, STRONG_PW } from "./helpers";

// KDBX export, end to end through the real extension: seed a vault, export it as a .kdbx under a
// password chosen for the FILE, then feed that file back through the app's own .kdbx import. The
// loop is the assertion — if the writer emits anything our reader (a real KDBX4 parser) can't
// open, or drops an entry on the way, the re-import step fails.
//
// Entries are seeded via the Bitwarden importer rather than the entry form: its fixture already
// holds a login with TOTP + custom fields, a card, a secure note and an SSH key, which is exactly
// the spread the export mapper has to flatten into KeePass String pairs.

const dir = path.dirname(fileURLToPath(import.meta.url));
const BITWARDEN_FIXTURE = path.resolve(
	dir,
	"../packages/platform-extension/src/fixtures/imports/bitwarden.json",
);

/** The password protecting the exported file. Deliberately not STRONG_PW: the export password is
 * independent of the master password, and reusing it here would hide a mix-up between the two. */
const FILE_PW = "Kd8-bxE-3xp0rt-Qw7-zL2";

/** Import a file through the options-page import flow, picking the card labelled `provider`. */
async function pickImportFile(page: Page, extensionId: string, provider: RegExp, file: string) {
	await page.goto(`${optionsUrl(extensionId)}?screen=import`);
	const card = page.locator("label").filter({ hasText: provider }).first();
	await expect(card).toBeVisible();
	await card.locator('input[type="file"]').setInputFiles(file);
}

/** Fill a vault with the 5-entry Bitwarden fixture (all four entry types). */
async function seedEntries(page: Page, extensionId: string) {
	await pickImportFile(page, extensionId, /Bitwarden/, BITWARDEN_FIXTURE);
	await page.getByRole("button", { name: /Import 5 items/i }).click();
	await expect(page.getByRole("heading", { name: /Imported 5 items/i })).toBeVisible();
}

/** From an unlocked popup, open Settings -> Backups and the KDBX export dialog. */
async function openExportDialog(page: Page) {
	await page.getByRole("button", { name: "Settings" }).click();
	await page.getByRole("button", { name: "Backups", exact: true }).click();
	// Both export rows carry a "Export" label, so target the aria-label that distinguishes them.
	await page.getByRole("button", { name: "Export as KeePass" }).click();
	const modal = page.getByRole("dialog");
	await expect(modal.getByRole("heading", { name: /Export as KeePass/i })).toBeVisible();
	return modal;
}

/** Run the export with `password`/`confirm` and return where the download landed. */
async function exportKdbx(page: Page, password: string, confirm = password) {
	const modal = await openExportDialog(page);
	await modal.locator('input[type="password"]').nth(0).fill(password);
	await modal.locator('input[type="password"]').nth(1).fill(confirm);
	const downloadPromise = page.waitForEvent("download");
	await modal.getByRole("button", { name: "Export", exact: true }).click();
	const download = await downloadPromise;
	const out = path.join(mkdtempSync(path.join(tmpdir(), "bramble-kdbx-")), "export.kdbx");
	await download.saveAs(out);
	return { out, download, modal };
}

test("exports the vault as a .kdbx the app can read back", async ({ context, extensionId }) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);
	await seedEntries(setup, extensionId);

	const page = await context.newPage();
	await openPopup(page, extensionId);
	const { out, download, modal } = await exportKdbx(page, FILE_PW);

	// Named for the vault + date, like the .bramble export.
	expect(download.suggestedFilename()).toMatch(/^bramble-vault-\d{4}-\d{2}-\d{2}\.kdbx$/);
	// KDBX4 signature + major version, so a structural break shows up here rather than as a
	// confusing parse error in the re-import below.
	const bytes = readFileSync(out);
	expect(bytes.subarray(0, 8).toString("hex")).toBe("03d9a29a67fb4bb5");
	expect(bytes.readUInt16LE(10)).toBe(4);
	// The dialog closes on success.
	await expect(modal).toBeHidden();

	// Read it back through the app's own .kdbx import: proof the file is a real KDBX4 database,
	// openable with the chosen password, still carrying every entry.
	const back = await context.newPage();
	await pickImportFile(back, extensionId, /KeePass \(\.kdbx\)/, out);
	await back.locator('input[type="password"]').first().fill(FILE_PW);
	await back.getByRole("button", { name: /Open database/i }).click();
	await expect(back.getByText(/5 items ready to import/i)).toBeVisible();
});

test("the exported file opens with the export password, not the master password", async ({
	context,
	extensionId,
}) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);
	await seedEntries(setup, extensionId);

	const page = await context.newPage();
	await openPopup(page, extensionId);
	const { out } = await exportKdbx(page, FILE_PW);

	// The master password must NOT open it. Asking for a separate password is the whole feature;
	// if the vault's own password worked, the export password would be decorative.
	const back = await context.newPage();
	await pickImportFile(back, extensionId, /KeePass \(\.kdbx\)/, out);
	await back.locator('input[type="password"]').first().fill(STRONG_PW);
	await back.getByRole("button", { name: /Open database/i }).click();
	// Assert the rejection positively (the reader's KDBX_WRONG_CREDENTIAL copy), not just the
	// absence of a preview: a flow that broke for any other reason would satisfy "no preview".
	await expect(back.getByText(/Wrong master password or key file/i)).toBeVisible();
	await expect(back.getByText(/items ready to import/i)).toBeHidden();

	// Then the export password on the SAME file does open it. Without this, the test would
	// still pass against a writer that emitted garbage nothing could ever open.
	await back.locator('input[type="password"]').first().fill(FILE_PW);
	await back.getByRole("button", { name: /Open database/i }).click();
	await expect(back.getByText(/5 items ready to import/i)).toBeVisible();
});

test("a mismatched confirmation blocks the export", async ({ context, extensionId }) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);

	const page = await context.newPage();
	await openPopup(page, extensionId);
	const modal = await openExportDialog(page);
	await modal.locator('input[type="password"]').nth(0).fill(FILE_PW);
	await modal.locator('input[type="password"]').nth(1).fill(`${FILE_PW}-typo`);
	await modal.getByRole("button", { name: "Export", exact: true }).click();

	await expect(modal.getByText(/don't match/i)).toBeVisible();
	// Dialog stays open so the typo is fixable, and nothing was written.
	await expect(modal.getByRole("heading", { name: /Export as KeePass/i })).toBeVisible();
});
