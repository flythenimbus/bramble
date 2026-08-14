// The desktop's scheduled backups: the platform half of @core/backup/run.
//
// This is the one target where a backup schedule can actually be kept. The app is tray-resident
// (closing the window hides it), a vault's sealed blob is readable with no key, and its target
// credentials sit in the OS credential store rather than under the vault key, so every input a
// run needs is available whether or not anything is unlocked. Each vault's timer is therefore
// evaluated on its own, locked or not.
//
// A target that predates a usable credential store (or a machine that has none, e.g. a Linux
// session with no Secret Service) keeps VEK-wrapped credentials and the old rule: it runs while
// its vault is unlocked, and is skipped, not failed, while it is not.
//
// The tick comes from Rust (`backup::start_ticker`), not from a timer here: this window is
// usually hidden and a hidden webview's timers are throttled by the platform.

import { createTarget, runBackup, sha256Hex } from "@core/backup";
import {
	type BackupSecrets,
	type BackupTargetConfig,
	backupTargetsKeyFor,
	keyVaultIdFor,
	migrateBackupTargetsToVaults,
	targetPrefixFor,
	toProviderConfig,
} from "@core/backup/config";
import { runScheduledBackups, type VaultBackup } from "@core/backup/run";
import { parseRegistry, VAULT_REGISTRY_KEY } from "@core/vault/vault-registry";
import { listen } from "@tauri-apps/api/event";
import { desktopBackupCreds } from "./adapters/backup-creds";
import { desktopCrypto } from "./adapters/crypto";
import { desktopStorage } from "./adapters/storage";

const TICK_EVENT = "backup://tick";

const newId = () => globalThis.crypto.randomUUID();

/** Every registered vault, default (first) flag included. */
async function registeredVaults(): Promise<{ id: string; isDefault: boolean }[]> {
	const reg = parseRegistry(await desktopStorage.getMeta(VAULT_REGISTRY_KEY));
	return reg.vaults.map((v) => ({ id: v.id, isDefault: v.id === reg.vaults[0]?.id }));
}

async function loadTargets(vaultId: string): Promise<BackupTargetConfig[]> {
	return (await desktopStorage.getMeta<BackupTargetConfig[]>(backupTargetsKeyFor(vaultId))) ?? [];
}

/** Every vault's sealed blob. Reading one needs no key, so a locked vault still has bytes. */
async function listVaults(): Promise<VaultBackup[]> {
	const vaults = await registeredVaults();
	await migrateBackupTargetsToVaults(
		desktopStorage,
		vaults.map((v) => v.id),
		newId,
	);
	const out: VaultBackup[] = [];
	for (const v of vaults) {
		try {
			out.push({
				id: v.id,
				blob: await desktopStorage.readVaultBlob(v.id),
				isDefault: v.isDefault,
			});
		} catch {}
	}
	return out;
}

let running = false;

/** Run whatever is due. Safe to call at any time; it no-ops unless a target is due and changed. */
export async function runDueBackups(): Promise<void> {
	if (running) return;
	running = true;
	try {
		const result = await runScheduledBackups(
			{
				listVaults,
				loadTargets,
				saveTargets: (vaultId, targets) =>
					desktopStorage.setMeta(backupTargetsKeyFor(vaultId), targets),
				// Per vault, so editing one vault does not re-upload the others.
				hashVault: (vault) => sha256Hex(vault.blob),
				// Only reached for a VEK-wrapped target (the OS-held ones never come through here).
				// The Rust side holds one VEK for the active vault, so a locked vault yields null,
				// which the runner treats as "not yet" rather than as a failure.
				decryptSecrets: async (_vaultId, creds) => {
					try {
						return JSON.parse(
							await desktopCrypto.decryptWithVek(creds.iv, creds.ciphertext),
						) as BackupSecrets;
					} catch {
						return null;
					}
				},
				upload: async (vaultId, t, secrets, vault) => {
					// Both paths go through the shell, because this window cannot reach a provider
					// either way. Stored credentials stay in the shell; a vault-wrapped one (no
					// credential store on this machine) is passed in with the request.
					const target = createTarget(
						toProviderConfig(t, secrets ?? { username: "", password: "" }),
						secrets === null
							? desktopBackupCreds.transport(vaultId, t)
							: desktopBackupCreds.transportWithSecrets(t, secrets),
					);
					await runBackup(target, vault.blob, {
						prefix: targetPrefixFor(t, vault.id, vault.isDefault),
						keep: t.keep,
						vaultId: keyVaultIdFor(t, vault.id),
					});
				},
			},
			Date.now(),
		);
		for (const f of result.failed) {
			console.warn(`[bramble] backup failed for ${f.id} (vault ${f.vaultId}):`, f.error);
		}
	} finally {
		running = false;
	}
}

/** Listen for the shell's tick. Returns an unsubscribe; call once, from the main window. */
export function startBackupSchedule(): () => void {
	const stop = listen(TICK_EVENT, () => {
		void runDueBackups().catch((e) => console.warn("[bramble] backup tick failed:", e));
	});
	return () => void stop.then((off) => off());
}
