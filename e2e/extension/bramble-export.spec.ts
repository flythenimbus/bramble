import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createVault, openPopup, optionsUrl, STRONG_PW } from "./helpers";

// The .bramble portable vault, end to end through the real extension: seed a vault, export a
// SELECTION from the list under a password chosen for the file, then read that file back through
// the app's own .bramble import.
//
// The loop is the point. Everything up to now was pinned on one side or the other: the crypto
// natively in core-rust, the VLT1 framing in vitest against a fake core. Nothing had ever sealed
// a real file in the browser and opened it again, so a mismatch between the Rust field names and
// the TS interface would have gone unnoticed until a user hit it.
//
// The passkey fixture is deliberate. Carrying passkeys is the reason this format exists rather
// than the KDBX export, so a round trip that quietly dropped them would otherwise still pass.

const dir = path.dirname(fileURLToPath(import.meta.url));
const PASSKEY_FIXTURE = path.resolve(
	dir,
	"../../packages/platform-extension/src/fixtures/imports/bitwarden-passkeys.json",
);

/** The password protecting the exported file. Deliberately not STRONG_PW, so a mix-up between the
 * file password and the master password cannot pass. */
const FILE_PW = "Br8-mbL-p0rt-Qk3-vT9";

async function pickImportFile(page: Page, extensionId: string, provider: RegExp, file: string) {
	await page.goto(`${optionsUrl(extensionId)}?screen=import`);
	const card = page.locator("label").filter({ hasText: provider }).first();
	await expect(card).toBeVisible();
	await card.locator('input[type="file"]').setInputFiles(file);
}

/** Seven entries, two of which hold a passkey. */
async function seedEntries(page: Page, extensionId: string) {
	await pickImportFile(page, extensionId, /Bitwarden/, PASSKEY_FIXTURE);
	await page.getByRole("button", { name: /Import 7 items/i }).click();
	await expect(page.getByRole("heading", { name: /Imported 7 items/i })).toBeVisible();
}

/** Enter selection mode in the vault list and tick everything. */
async function selectAll(popup: Page) {
	await popup.getByRole("button", { name: "Select items" }).click();
	await popup.getByRole("button", { name: "Select all" }).click();
}

/** Run the bulk export and return where the download landed. */
async function exportSelection(popup: Page, password: string, confirm = password) {
	await popup.getByRole("button", { name: "Actions" }).click();
	await popup.getByRole("menuitem", { name: /Export selection/i }).click();
	const modal = popup.getByRole("dialog");
	await expect(modal.getByRole("heading", { name: /Export selection/i })).toBeVisible();
	await modal.locator('input[type="password"]').nth(0).fill(password);
	await modal.locator('input[type="password"]').nth(1).fill(confirm);
	const downloadPromise = popup.waitForEvent("download");
	await modal.getByRole("button", { name: "Export", exact: true }).click();
	const download = await downloadPromise;
	const out = path.join(mkdtempSync(path.join(tmpdir(), "bramble-portable-")), "export.bramble");
	await download.saveAs(out);
	return { out, download, modal };
}

/** Feed a .bramble to the import flow and submit `password` at the credential step. */
async function openBrambleFile(page: Page, extensionId: string, file: string, password: string) {
	await pickImportFile(page, extensionId, /Bramble/, file);
	await page.locator('input[type="password"]').first().fill(password);
	await page.getByRole("button", { name: /Open database/i }).click();
}

test("exports a selection as a .bramble the app can read back", async ({
	context,
	extensionId,
}) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);
	await seedEntries(setup, extensionId);

	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await selectAll(popup);
	const { out, download, modal } = await exportSelection(popup, FILE_PW);

	expect(download.suggestedFilename()).toMatch(/^bramble-selection-\d{4}-\d{2}-\d{2}\.bramble$/);
	// VLT1 magic, so a structural break surfaces here rather than as a confusing parse error in
	// the re-import below.
	expect(readFileSync(out).subarray(0, 4).toString("ascii")).toBe("VLT1");
	await expect(modal).toBeHidden();

	// Into a SECOND, empty vault: re-importing into the source vault would be recognised as
	// entries it already holds and skipped, which proves nothing about the file.
	await createVault(await context.newPage(), extensionId);
	const back = await context.newPage();
	await openBrambleFile(back, extensionId, out, FILE_PW);
	await expect(back.getByText(/7 items ready to import/i)).toBeVisible();
	// Through to the WRITE, not just the preview. Decrypting the file and persisting what came
	// out are separate failures: the first version of this shipped vault-local ids, which
	// previewed perfectly and then died on "missing sync stamp" the moment it wrote.
	await back.getByRole("button", { name: /Import 7 items/i }).click();
	await expect(back.getByRole("heading", { name: /Imported 7 items/i })).toBeVisible();
});

test("the round trip carries passkeys, which the KDBX export cannot", async ({
	context,
	extensionId,
}) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);
	await seedEntries(setup, extensionId);

	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await selectAll(popup);
	const { out } = await exportSelection(popup, FILE_PW);

	await createVault(await context.newPage(), extensionId);
	const back = await context.newPage();
	await openBrambleFile(back, extensionId, out, FILE_PW);
	await back.getByRole("button", { name: /Import 7 items/i }).click();
	await expect(back.getByRole("heading", { name: /Imported 7 items/i })).toBeVisible();

	// The marker is driven by the entry actually holding passkey material, so its presence after
	// a full export/import cycle is the assertion that the credential survived intact.
	const reimported = await context.newPage();
	await openPopup(reimported, extensionId);
	const withPasskey = reimported
		.locator("div")
		.filter({ hasText: /^webauthn\.io/ })
		.first();
	await expect(withPasskey.getByLabel(/Holds a passkey/i)).toBeVisible();
});

test("the file opens with the export password, not the master password", async ({
	context,
	extensionId,
}) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);
	await seedEntries(setup, extensionId);

	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await selectAll(popup);
	const { out } = await exportSelection(popup, FILE_PW);

	await createVault(await context.newPage(), extensionId);
	const back = await context.newPage();
	// Asking for a separate password is the whole point: the file must not carry a key the
	// vault's own password can reach.
	await openBrambleFile(back, extensionId, out, STRONG_PW);
	// Assert the rejection positively rather than just the absence of a preview, which a flow
	// broken for any other reason would also satisfy.
	await expect(back.getByText(/didn't open the file/i)).toBeVisible();
	await expect(back.getByText(/items ready to import/i)).toBeHidden();

	// The export password on the SAME file does open it. Without this the test would pass
	// against a writer that emitted garbage nothing could ever open.
	await back.locator('input[type="password"]').first().fill(FILE_PW);
	await back.getByRole("button", { name: /Open database/i }).click();
	await expect(back.getByText(/7 items ready to import/i)).toBeVisible();
});

test("exports only what was selected", async ({ context, extensionId }) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);
	await seedEntries(setup, extensionId);

	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await popup.getByRole("button", { name: "Select items" }).click();
	// Two rows only, so a file holding all seven (a selection quietly ignored) fails here.
	// Click the label, not the input: the input is `sr-only` under a styled span, so the
	// span is what a real click lands on and Playwright's check() cannot reach the input.
	const boxes = popup.locator('label:has(input[type="checkbox"])');
	await boxes.nth(0).click();
	await boxes.nth(1).click();
	await expect(popup.getByText("2 selected")).toBeVisible();
	const { out } = await exportSelection(popup, FILE_PW);

	await createVault(await context.newPage(), extensionId);
	const back = await context.newPage();
	await openBrambleFile(back, extensionId, out, FILE_PW);
	await expect(back.getByText(/2 items ready to import/i)).toBeVisible();
});

test("re-importing the same file adds nothing", async ({ context, extensionId }) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);
	await seedEntries(setup, extensionId);

	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await selectAll(popup);
	const { out } = await exportSelection(popup, FILE_PW);

	// Straight back into the source vault, which already holds every one of them. Import merges,
	// so the dedup every other provider gets has to apply here too rather than duplicating the
	// whole selection.
	const back = await context.newPage();
	await openBrambleFile(back, extensionId, out, FILE_PW);
	await expect(back.getByText(/already in your vault/i)).toBeVisible();
	await expect(back.getByText(/items ready to import/i)).toBeHidden();
});
