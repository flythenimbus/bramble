import type { BrowserContext, Page, Worker } from "@playwright/test";
import { expect, test } from "./fixtures";
import { backgroundWorker, createVault, expectUnlocked, openPopup, STRONG_PW } from "./helpers";

// The one-time "namespace every vault by id" copy migration, exercised end-to-end in a real Chrome
// build. A vault is created normally (namespaced), then rewritten into the pre-namespacing FLAT
// layout an old build left behind; opening a fresh popup (a fresh JS context => a fresh migration
// memo) re-runs runMigration. We assert the vault still opens and its sync identity is copied
// verbatim, so paired peers don't re-pair. See docs/multiple-vaults.md and storage.ts.

// A paired vault's sync identity, at the flat keys an old build wrote.
const FLAT_SYNC = {
	"sync.group": { groupKey: "dGVzdC1ncm91cA==", roster: { devices: [], revoked: [] } },
	"sync.deviceKeypair": { privateKey: "PRIV-B64", publicKey: "PUB-B64" },
	"sync.signingKey": { secretKey: "SEC-B64", publicKey: "VPUB-B64" },
	"sync.deviceId": "device-abc",
	"sync.lastSyncedAt": 1_700_000_000_000,
} as const;

const NS_BASES = ["vault-blob-b64", "vault-blob-backup-b64", ...Object.keys(FLAT_SYNC)];

/**
 * Rewrite a freshly-created vault's storage into the pre-namespacing flat layout: the blob at the
 * un-suffixed key + flat sync keys, and the session cleared (an update drops the cached VEK).
 * `keepRegistry` picks the two real starting points - a released single-vault install (no registry)
 * vs a transitional one (a registry that still names the flat vault via the retired legacyBlobVaultId).
 * Returns the vault id it had before de-migrating.
 */
async function demigrate(context: BrowserContext, keepRegistry: boolean): Promise<string> {
	const sw = await backgroundWorker(context);
	return sw.evaluate(
		async ({ flatSync, keep, bases }) => {
			const all = await chrome.storage.local.get(null);
			const id = (all["vault.registry"] as { vaults: { id: string }[] }).vaults[0]!.id;
			await chrome.storage.local.set({
				"vault-blob-b64": all[`vault-blob-b64:${id}`],
				...flatSync,
			});
			await chrome.storage.local.remove(bases.map((b) => `${b}:${id}`));
			if (keep) {
				await chrome.storage.local.set({
					"vault.registry": {
						vaults: (all["vault.registry"] as { vaults: unknown[] }).vaults,
						legacyBlobVaultId: id,
					},
				});
			} else {
				await chrome.storage.local.remove("vault.registry");
			}
			await chrome.storage.session.clear();
			return id;
		},
		{ flatSync: FLAT_SYNC, keep: keepRegistry, bases: NS_BASES },
	);
}

/** Open the vault from a just-loaded popup: unlock with the password, or accept an already-open vault. */
async function openVault(popup: Page): Promise<void> {
	const lockBtn = popup.getByRole("button", { name: "Lock vault", exact: true });
	const pw = popup.locator('input[type="password"]').first();
	await expect(lockBtn.or(pw)).toBeVisible();
	if (!(await lockBtn.isVisible())) {
		await pw.fill(STRONG_PW);
		await popup.getByRole("button", { name: "Unlock Vault" }).click();
	}
	await expectUnlocked(popup);
}

async function assertMigrated(sw: Worker, expectedId?: string): Promise<void> {
	const s = await sw.evaluate(async () => {
		const all = await chrome.storage.local.get(null);
		const reg = all["vault.registry"] as { vaults: { id: string }[]; legacyBlobVaultId?: string };
		const id = reg.vaults[0]!.id;
		return {
			id,
			vaultCount: reg.vaults.length,
			hasLegacyPointer: "legacyBlobVaultId" in reg,
			blobNamespaced: typeof all[`vault-blob-b64:${id}`] === "string",
			flatBlobPresent: "vault-blob-b64" in all,
			flatGroupPresent: "sync.group" in all,
			group: all[`sync.group:${id}`],
			keypair: all[`sync.deviceKeypair:${id}`],
			signingKey: all[`sync.signingKey:${id}`],
			deviceId: all[`sync.deviceId:${id}`],
			lastSyncedAt: all[`sync.lastSyncedAt:${id}`],
		};
	});
	if (expectedId) expect(s.id).toBe(expectedId); // a transitional install keeps the vault's id
	expect(s.vaultCount).toBe(1);
	expect(s.hasLegacyPointer).toBe(false);
	expect(s.blobNamespaced).toBe(true);
	expect(s.flatBlobPresent).toBe(false);
	expect(s.flatGroupPresent).toBe(false);
	// The sync identity is copied byte-for-byte, so the device stays paired (no re-pair).
	expect(s.group).toEqual(FLAT_SYNC["sync.group"]);
	expect(s.keypair).toEqual(FLAT_SYNC["sync.deviceKeypair"]);
	expect(s.signingKey).toEqual(FLAT_SYNC["sync.signingKey"]);
	expect(s.deviceId).toBe(FLAT_SYNC["sync.deviceId"]);
	expect(s.lastSyncedAt).toBe(FLAT_SYNC["sync.lastSyncedAt"]);
}

test("migrates a released single-vault install (flat blob, no registry) and still unlocks", async ({
	context,
	extensionId,
}) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);
	await demigrate(context, /* keepRegistry */ false);

	// A fresh popup re-runs the migration; the vault must open (not show "create a vault") even
	// though the flat layout had no registry.
	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await openVault(popup);

	await assertMigrated(await backgroundWorker(context));
});

test("migrates a transitional install (registry still points flat via legacyBlobVaultId), keeping the id", async ({
	context,
	extensionId,
}) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);
	const origId = await demigrate(context, /* keepRegistry */ true);

	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await openVault(popup);

	await assertMigrated(await backgroundWorker(context), origId);
});
