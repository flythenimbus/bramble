import { useCallback, useEffect } from "react";
import { useSyncedSettings } from "../../hooks/synced-settings";
import { useVaultRegistry } from "../../hooks/useVaultRegistry";

/** The synced setting holding the vault's name. */
export const VAULT_NAME_KEY = "vault.name";

/**
 * Keep the open vault's name the same on every device in its sync group.
 *
 * The name lives in the vault's encrypted synced settings, so it rides sync, and a device joining
 * the group receives it in the enrollment bundle with everything else. The registry keeps a copy,
 * because the picker and the unlock screen show the name while the vault is locked and its
 * settings cannot be read; this keeps that copy in step whenever the vault is open. A vault named
 * before names synced has none in its settings, so its local name is published once from here.
 *
 * Mounted under an unlocked vault, but the active vault can change there: linking from Settings
 * opens another one under this screen. `ready` is what says the settings in hand are the active
 * vault's. See docs/synced-settings.md.
 */
export function useVaultNameSync(): void {
	const synced = useSyncedSettings();
	const { activeId, vaults, rename } = useVaultRegistry();
	const local = vaults.find((v) => v.id === activeId)?.label;
	const record = synced.settings?.[VAULT_NAME_KEY];
	// A cleared or malformed value reads as unnamed ("Vault N"), never as "not synced yet".
	const remote =
		record === undefined ? undefined : typeof record.value === "string" ? record.value : "";

	useEffect(() => {
		if (!synced.ready || local === undefined) return;
		if (remote === undefined) {
			if (local.trim()) void synced.set(VAULT_NAME_KEY, local).catch(() => {});
			return;
		}
		if (remote !== local) void rename(remote).catch(() => {});
	}, [synced.ready, synced.set, local, remote, rename]);
}

/**
 * Rename the open vault on every device. The synced name is written first, so useVaultNameSync
 * never sees the registry run ahead of it and put the old name back.
 */
export function useRenameVault(): (name: string) => Promise<void> {
	const synced = useSyncedSettings();
	const { rename } = useVaultRegistry();
	return useCallback(
		async (name: string) => {
			if (synced.ready) await synced.set(VAULT_NAME_KEY, name);
			await rename(name);
		},
		[synced, rename],
	);
}
