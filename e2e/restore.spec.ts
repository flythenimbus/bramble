import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures";
import { backgroundWorker, createVault, optionsUrl, STRONG_PW } from "./helpers";

// Restoring a .bramble backup when a vault already exists must ADD a new vault, never overwrite the
// vault on this device (the old code did an id-less write straight over the primary - a data-loss
// footgun reachable from Settings -> Data -> Restore from backup).
test("restoring a backup when a vault exists adds a new vault, never overwrites", async ({
	context,
	extensionId,
}) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);

	// A .bramble backup is just a VLT1 blob. Reuse vault 1's own blob as the backup file (same
	// password), written to a temp .bramble the file picker can accept.
	const sw = await backgroundWorker(context);
	const b64 = await sw.evaluate(async () => {
		const reg = (await chrome.storage.local.get("vault.registry"))["vault.registry"] as {
			vaults: { id: string }[];
		};
		const key = `vault-blob-b64:${reg.vaults[0]!.id}`;
		return (await chrome.storage.local.get(key))[key] as string;
	});
	const dir = mkdtempSync(path.join(tmpdir(), "bramble-backup-"));
	const file = path.join(dir, "backup.bramble");
	writeFileSync(file, Buffer.from(b64, "base64"));

	const page = await context.newPage();
	await page.goto(`${optionsUrl(extensionId)}?screen=restore`);
	await page.locator('input[type="file"]').setInputFiles(file);
	// The "add as a new vault" copy only shows once the existing-vault check resolved (hasVault).
	await expect(page.getByText(/as a new vault/i)).toBeVisible();
	await page.locator('input[type="password"]').first().fill(STRONG_PW);
	await page.getByRole("button", { name: /Restore vault/i }).click();

	// It was added, not overwritten in place.
	await expect(page.getByRole("heading", { name: /Vault added/i })).toBeVisible();
	const vaultCount = await sw.evaluate(async () => {
		const reg = (await chrome.storage.local.get("vault.registry"))["vault.registry"] as {
			vaults?: unknown[];
		};
		return reg?.vaults?.length ?? 0;
	});
	expect(vaultCount).toBe(2);
});

// The "Add a vault" screen (shown once a vault exists) offers restoring a .bramble backup as a
// new vault, via a tab that opens the restore flow.
test("the Add-a-vault screen offers restoring a backup", async ({ context, extensionId }) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);

	const page = await context.newPage();
	await page.goto(optionsUrl(extensionId));
	await expect(page.getByRole("heading", { name: /Add a vault/i })).toBeVisible();
	await page.getByRole("button", { name: /Restore from backup/i }).click();
	// The restore flow opened (its file picker is present).
	await expect(page.locator('input[type="file"]')).toBeAttached();
});
