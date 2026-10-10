import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures";
import {
	backgroundWorker,
	createVault,
	lockToPicker,
	openPopup,
	optionsUrl,
	STRONG_PW,
	seedExampleLogin,
	selectVault,
} from "./helpers";

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

// The other half: restoring with NO vault on the device, which is what a fresh install and a
// "backed up, then deleted the vault" device both look like. It has to mint the registry record
// itself - storage refuses a blind write into an empty registry, so the branch that used to rely
// on that write minting the record died with "no vault id, and no vault registered" (issue #41).
test("restoring a backup with no vault on the device fills the first vault and unlocks it", async ({
	context,
	extensionId,
}) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);

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

	// Take the vault away, leaving the backup file: the issue's repro, and equivalent to a fresh
	// install as far as the restore screen can tell (empty registry, no blob).
	await setup.close();
	await sw.evaluate(() => chrome.storage.local.clear());

	const page = await context.newPage();
	await page.goto(`${optionsUrl(extensionId)}?screen=restore`);
	await page.locator('input[type="file"]').setInputFiles(file);
	// The first-vault copy, not the "as a new vault" copy: this is the branch under test.
	await expect(page.getByText(/as the vault on this device/i)).toBeVisible();
	await page.locator('input[type="password"]').first().fill(STRONG_PW);
	await page.getByRole("button", { name: /Restore vault/i }).click();

	await expect(page.getByRole("heading", { name: /Vault restored/i })).toBeVisible();
	// One vault, registered AND written: a record without a blob is the ghost the startup reaper
	// exists to clean up, so assert the pair rather than just the count.
	const state = await sw.evaluate(async () => {
		const reg = (await chrome.storage.local.get("vault.registry"))["vault.registry"] as {
			vaults?: { id: string }[];
		};
		const ids = reg?.vaults?.map((v) => v.id) ?? [];
		const key = `vault-blob-b64:${ids[0]}`;
		return {
			count: ids.length,
			hasBlob: typeof (await chrome.storage.local.get(key))[key] === "string",
		};
	});
	expect(state).toEqual({ count: 1, hasBlob: true });
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

// The way back for a user stuck on "aes decrypt: aead::Error": from the lock screen, restore a
// healthy device's backup as a new vault and open that one instead.
test("a vault that won't decrypt can be replaced from its lock screen", async ({
	context,
	extensionId,
}) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);
	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);

	// The backup a healthy device would export: these bytes while still readable.
	const sw = await backgroundWorker(context);
	const key = await sw.evaluate(async () => {
		const reg = (await chrome.storage.local.get("vault.registry"))["vault.registry"] as {
			vaults: { id: string }[];
		};
		return `vault-blob-b64:${reg.vaults[0]!.id}`;
	});
	const b64 = await sw.evaluate(async (k) => (await chrome.storage.local.get(k))[k] as string, key);
	const dir = mkdtempSync(path.join(tmpdir(), "bramble-backup-"));
	const file = path.join(dir, "backup.bramble");
	writeFileSync(file, Buffer.from(b64, "base64"));

	// A second vault, as the user has: only then does the lock screen offer the vault picker.
	await createVault(setup, extensionId);
	// openOptionsPage focuses an open options tab instead of opening one.
	await setup.close();
	await openPopup(popup, extensionId);
	await lockToPicker(popup);

	// Break the first vault's copy: the entries' auth tag is the blob's last byte.
	await sw.evaluate(async (k) => {
		const raw = atob((await chrome.storage.local.get(k))[k] as string);
		const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
		const last = bytes.length - 1;
		bytes[last] = (bytes[last] ?? 0) ^ 0xff;
		await chrome.storage.local.set({ [k]: btoa(String.fromCharCode(...bytes)) });
	}, key);
	await popup.getByRole("button", { name: /Vault 1/ }).click();
	await popup.locator('input[type="password"]').first().fill(STRONG_PW);
	await popup.getByRole("button", { name: "Unlock Vault" }).click();
	await expect(popup.getByText(/aes decrypt: aead::Error/)).toBeVisible();

	// The recovery, as the user would click it.
	await popup.getByRole("button", { name: /Choose a different vault/i }).click();
	const [restoreTab] = await Promise.all([
		context.waitForEvent("page"),
		popup.getByRole("button", { name: /Create new vault/i }).click(),
	]);
	await restoreTab.getByRole("button", { name: /Restore from backup/i }).click();
	await restoreTab.locator('input[type="file"]').setInputFiles(file);
	await restoreTab.getByLabel("Vault name").fill("Recovered");
	await restoreTab.locator('input[type="password"]').first().fill(STRONG_PW);
	await restoreTab.getByRole("button", { name: /Restore vault/i }).click();
	await expect(restoreTab.getByRole("heading", { name: /Vault added/i })).toBeVisible();

	const reopened = await context.newPage();
	await openPopup(reopened, extensionId);
	const picker = reopened.getByRole("heading", { name: /Choose a vault/i });
	const switchLink = reopened.getByRole("button", { name: /Choose a different vault/i });
	await expect(picker.or(switchLink)).toBeVisible();
	if (!(await picker.isVisible())) await switchLink.click();
	await selectVault(reopened, /Recovered/);
	await expect(reopened.getByText("Example Login")).toBeVisible();
});
