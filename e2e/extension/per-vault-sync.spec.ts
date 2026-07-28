import { expect, test } from "./fixtures";
import {
	backgroundWorker,
	createVault,
	expectUnlocked,
	gotoSync,
	localStorageKeys,
	lockToPicker,
	openPopup,
	selectVault,
} from "./helpers";

// Increment 4: the actual per-vault behaviour. A device that set up sync on one vault must show a
// second, independent vault as un-synced (the bug this feature fixed: vault 2 showed vault 1's
// paired devices). Drives the real popup UI (picker + Settings) and inspects real background storage.
test("a second vault has its own, independent sync state", async ({ context, extensionId }) => {
	// Two vaults, each addressed by id (sync keys namespaced `<key>:<id>`).
	const setup = await context.newPage();
	await createVault(setup, extensionId);
	const setup2 = await context.newPage();
	await createVault(setup2, extensionId);

	// Put the FIRST vault into a "synced" state by seeding its group at its namespaced key (what an
	// enrollment writes), without needing a second real device.
	const sw = await backgroundWorker(context);
	await sw.evaluate(async () => {
		const reg = (await chrome.storage.local.get("vault.registry"))["vault.registry"] as {
			vaults: { id: string }[];
		};
		await chrome.storage.local.set({
			[`sync.group:${reg.vaults[0]!.id}`]: {
				groupKey: "dGVzdC1ncm91cA==",
				roster: { devices: [], revoked: [] },
			},
		});
	});

	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	// Vault 2 was just created + unlocked, so the popup opens straight on it (not the picker). Its
	// panel is in the onboarding state - it does NOT show vault 1's group.
	await expectUnlocked(popup);
	await gotoSync(popup);
	await expect(popup.getByRole("button", { name: /Add a device/i })).toBeVisible();
	await expect(popup.getByRole("button", { name: /Disconnect/i })).toHaveCount(0);

	// Switch to vault 1: its panel reflects the seeded group (a synced vault can be disconnected).
	await lockToPicker(popup);
	await selectVault(popup, /Vault 1/);
	await gotoSync(popup);
	await expect(popup.getByRole("button", { name: /Disconnect/i })).toBeVisible();

	// Storage confirms the isolation: exactly one vault (vault 1) has a namespaced group key, vault 2
	// never synced, and there is no flat group key. Both vaults are registered.
	const keys = await localStorageKeys(context);
	expect(keys).not.toContain("sync.group");
	expect(keys.filter((k) => k.startsWith("sync.group:"))).toHaveLength(1);
	const vaultCount = await sw.evaluate(async () => {
		const reg = (await chrome.storage.local.get("vault.registry"))["vault.registry"] as {
			vaults?: unknown[];
		};
		return reg?.vaults?.length ?? 0;
	});
	expect(vaultCount).toBe(2);
});
