import { expect, test } from "./fixtures";
import {
	backgroundWorker,
	createVault,
	expectUnlocked,
	gotoBackups,
	localStorageKeys,
	lockToPicker,
	openPopup,
	selectVault,
} from "./helpers";

// Issue #49: cloud backup targets used to live at one device-global `backup.targets` key, so
// setting up (say) Nextcloud in a personal vault silently configured every other vault with the
// same server, credentials and folder. They are per-vault now (`backup.targets:<id>`). These specs
// drive the real popup UI and inspect real background storage.

const WEBDAV_URL = "https://cloud.example.test/remote.php/dav/files/tester/";

/** A configured WebDAV target, as the Settings form would have written it. The credentials are
 * never unwrapped here (no backup is run), so a placeholder is enough. */
function seedTarget(path: string) {
	return {
		id: "seeded-target",
		providerId: "nextcloud",
		provider: "webdav",
		serverUrl: WEBDAV_URL,
		path,
		frequency: "daily",
		keep: 30,
		creds: { iv: "AAAA", ciphertext: "BBBB" },
	};
}

/** Every registered vault id, in registry order (the first is the default vault). */
async function vaultIds(context: Parameters<typeof backgroundWorker>[0]): Promise<string[]> {
	const sw = await backgroundWorker(context);
	return sw.evaluate(async () => {
		const reg = (await chrome.storage.local.get("vault.registry"))["vault.registry"] as {
			vaults: { id: string }[];
		};
		return reg.vaults.map((v) => v.id);
	});
}

test("a second vault does not inherit the first vault's backup target", async ({
	context,
	extensionId,
}) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);
	const setup2 = await context.newPage();
	await createVault(setup2, extensionId);

	// Configure the FIRST vault by seeding its namespaced target list (what the Settings form
	// writes), without needing a real provider.
	const [firstVault] = await vaultIds(context);
	const sw = await backgroundWorker(context);
	await sw.evaluate(
		async ([key, target]) => {
			await chrome.storage.local.set({ [key as string]: [target] });
		},
		[`backup.targets:${firstVault}`, seedTarget("/backups/passmanager/personal")] as const,
	);

	// Vault 2 was just created + unlocked, so the popup opens straight on it. Its Backups panel is
	// in the onboarding state: no target, and nothing pointing at vault 1's server.
	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);
	await gotoBackups(popup);
	await expect(popup.getByText(/Choose where to store encrypted backups/i)).toBeVisible();
	await expect(popup.getByRole("button", { name: /Back up now/i })).toHaveCount(0);
	await expect(popup.getByText(WEBDAV_URL)).toHaveCount(0);

	// Vault 1 has it.
	await lockToPicker(popup);
	await selectVault(popup, /Vault 1/);
	await gotoBackups(popup);
	await expect(popup.getByRole("button", { name: /Back up now/i })).toBeVisible();
	await expect(popup.getByText(WEBDAV_URL)).toBeVisible();

	// Storage confirms the isolation: one namespaced list, and no device-global key.
	const keys = await localStorageKeys(context);
	expect(keys).not.toContain("backup.targets");
	expect(keys.filter((k) => k.startsWith("backup.targets:"))).toEqual([
		`backup.targets:${firstVault}`,
	]);
});

test("an existing device-global target list is adopted by every vault, once", async ({
	context,
	extensionId,
}) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);
	const setup2 = await context.newPage();
	await createVault(setup2, extensionId);

	// The pre-upgrade state: one shared list at the flat key, backing up both vaults.
	const sw = await backgroundWorker(context);
	await sw.evaluate(async (target) => {
		await chrome.storage.local.set({ "backup.targets": [target] });
	}, seedTarget("backups"));

	// Opening the panel migrates: the flat key is copied to each vault, then dropped.
	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);
	await gotoBackups(popup);
	await expect(popup.getByText(WEBDAV_URL)).toBeVisible();

	const ids = await vaultIds(context);
	const keys = await localStorageKeys(context);
	expect(keys).not.toContain("backup.targets");
	expect(keys.filter((k) => k.startsWith("backup.targets:")).sort()).toEqual(
		ids.map((id) => `backup.targets:${id}`).sort(),
	);

	// Each copy keeps the folder layout it already backs up to: the default vault at the plain
	// folder, the second one at its sibling `<folder>-<id>`. The panel shows the resolved folder.
	const [first, second] = ids;
	await expect(popup.getByText(`backups-${second}`)).toBeVisible();
	await lockToPicker(popup);
	await selectVault(popup, /Vault 1/);
	await gotoBackups(popup);
	await expect(popup.getByText("This vault's folder: backups", { exact: true })).toBeVisible();

	// Removing it from vault 1 leaves vault 2's copy alone: the lists are independent now.
	await popup.getByRole("button", { name: /Remove/i }).click();
	await expect(popup.getByText(/Choose where to store encrypted backups/i)).toBeVisible();
	const after = await sw.evaluate(
		async (keysToRead) => {
			const got = await chrome.storage.local.get(keysToRead as string[]);
			return (keysToRead as string[]).map((k) => (got[k] as unknown[] | undefined)?.length ?? -1);
		},
		[`backup.targets:${first}`, `backup.targets:${second}`] as const,
	);
	expect(after).toEqual([0, 1]);
});
