import { readFileSync } from "node:fs";
import { expect, test } from "./fixtures";
import {
	gotoBackups,
	lock,
	openExampleLogin,
	optionsUrl,
	STRONG_PW,
	selectVault,
	unlock,
} from "./helpers";

// File attachments through the real extension: the view parks the picked file in IndexedDB, the
// offscreen document seals it with the wasm streams into the vault's store, and opening runs the
// same way back to a download. Each hop crosses an extension context, which is exactly what the
// unit suites stub out, so this is the one place the whole path is shown to connect.

// Three sealed chunks, the last one short: enough to catch a boundary or final-flag slip.
const CHUNK = 256 * 1024;
const BODY = Buffer.from(Uint8Array.from({ length: 2 * CHUNK + 4321 }, (_, i) => (i * 31) % 251));

test("attaches a file, then opens it byte for byte after a lock", async ({
	context,
	extensionId,
}) => {
	// The detached window, where a file picker survives.
	const popup = await openExampleLogin(context, extensionId, { detached: true });

	await popup.locator('input[type="file"]').setInputFiles({
		name: "tax return 2026.pdf",
		mimeType: "application/pdf",
		buffer: BODY,
	});
	// The name is sealed, so seeing it means the record's metadata opened again.
	await expect(popup.getByText("tax return 2026.pdf")).toBeVisible();

	await lock(popup);
	await unlock(popup);
	await popup.getByText("Example Login").click();
	await expect(popup.getByText("tax return 2026.pdf")).toBeVisible();

	const downloading = popup.waitForEvent("download");
	await popup.getByRole("button", { name: "Open attachment" }).click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe("tax return 2026.pdf");
	const saved = readFileSync((await download.path()) as string);
	expect(saved.equals(BODY)).toBe(true);

	// Removing asks first, in place: Cancel keeps it, the confirming click removes it.
	await popup.getByRole("button", { name: "Remove attachment" }).click();
	await popup.getByRole("group").getByRole("button", { name: "Cancel" }).click();
	await expect(popup.getByText("tax return 2026.pdf")).toBeVisible();
	await popup.getByRole("button", { name: "Remove attachment" }).click();
	await popup.getByRole("group").getByRole("button", { name: "Remove" }).click();
	await expect(popup.getByText("tax return 2026.pdf")).toHaveCount(0);
});

test("the attached popup hands attaching over to its own window", async ({
	context,
	extensionId,
}) => {
	const popup = await openExampleLogin(context, extensionId);

	await expect(
		popup.getByRole("button", { name: "Popout to window to attach files" }),
	).toBeVisible();
	await expect(popup.locator('input[type="file"]')).toHaveCount(0);
});

// A backup of a vault with attachments is one ZIP carrying the files. Export it from one vault,
// restore it as a second, and the file must open from the second vault's own store.
test("an exported backup carries the attachment into the vault it restores", async ({
	context,
	extensionId,
}) => {
	const popup = await openExampleLogin(context, extensionId, { detached: true });
	await popup.locator('input[type="file"]').setInputFiles({
		name: "deed.pdf",
		mimeType: "application/pdf",
		buffer: BODY,
	});
	await expect(popup.getByText("deed.pdf")).toBeVisible();

	await popup.getByRole("button", { name: "Go to vault" }).click();
	await gotoBackups(popup);
	const exporting = popup.waitForEvent("download");
	await popup.getByRole("button", { name: "Export an encrypted backup" }).click();
	const backup = await (await exporting).path();
	// A ZIP, not the bare vault blob: the attachment made it into the file.
	expect(
		readFileSync(backup as string)
			.subarray(0, 2)
			.toString(),
	).toBe("PK");

	const restore = await context.newPage();
	await restore.goto(`${optionsUrl(extensionId)}?screen=restore`);
	await restore.locator('input[type="file"]').setInputFiles(backup as string);
	await expect(restore.getByText(/as a new vault/i)).toBeVisible();
	await restore.locator('input[type="password"]').first().fill(STRONG_PW);
	await restore.getByRole("button", { name: /Restore vault/i }).click();
	await expect(restore.getByRole("heading", { name: /Vault added/i })).toBeVisible();

	// Open the restored vault and read the file back out of its own store. Restoring locked this
	// popup, and it reads the vault list when it opens, so reopen it as a user would.
	await popup.reload();
	await popup.getByRole("button", { name: /Choose a different vault/i }).click();
	await selectVault(popup, /Vault 2/);
	await popup.getByText("Example Login").click();
	await expect(popup.getByText("deed.pdf")).toBeVisible();
	const downloading = popup.waitForEvent("download");
	await popup.getByRole("button", { name: "Open attachment" }).click();
	const saved = readFileSync((await (await downloading).path()) as string);
	expect(saved.equals(BODY)).toBe(true);
});
