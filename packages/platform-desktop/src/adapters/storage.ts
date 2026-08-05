// StorageAdapter over the native filesystem, via the Rust shell. Bytes ride as number
// arrays because Tauri's IPC is JSON; vault blobs are small enough that this is not the
// bottleneck, and moving to a raw-bytes channel is a local change if that stops being true.

import type { StorageAdapter } from "@core/adapters/storage";
import { invoke } from "@tauri-apps/api/core";

export const desktopStorage: StorageAdapter = {
	hasVaultHandle: (vaultId) => invoke<boolean>("storage_has_vault", { vaultId }),

	readVaultBlob: async (vaultId) =>
		Uint8Array.from(await invoke<number[]>("storage_read_vault", { vaultId })),

	writeVaultBlob: (blob, vaultId) =>
		invoke<void>("storage_write_vault", { blob: Array.from(blob), vaultId }),

	// The shell snapshots the previous bytes before every overwrite, so this is a plain read.
	restoreVaultFromBackup: (vaultId) => invoke<boolean>("storage_restore_vault_backup", { vaultId }),

	readVaultBackup: async (vaultId) => {
		const bytes = await invoke<number[] | null>("storage_read_vault_backup", { vaultId });
		return bytes ? Uint8Array.from(bytes) : null;
	},

	deleteVaultBlob: (vaultId) => invoke<void>("storage_delete_vault", { vaultId }),

	getMeta: async <T>(key: string) => {
		const value = await invoke<T | null>("storage_get_meta", { key });
		return value === null ? undefined : value;
	},
	setMeta: (key, value) => invoke<void>("storage_set_meta", { key, value }),
	removeMeta: (key) => invoke<void>("storage_remove_meta", { key }),

	// subscribeMeta is deliberately absent: one process, one window, so nothing writes
	// metadata out of context yet. The sync hub and spotlight window will both need it.
};
