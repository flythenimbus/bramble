// StorageAdapter over the native filesystem, via the Rust shell. Bytes ride as number
// arrays because Tauri's IPC is JSON; vault blobs are small enough that this is not the
// bottleneck, and moving to a raw-bytes channel is a local change if that stops being true.

import type { StorageAdapter } from "@core/adapters/storage";
import { invoke } from "@tauri-apps/api/core";

const metaListeners = new Map<string, Set<() => void>>();

function notifyMeta(key: string): void {
	for (const cb of metaListeners.get(key) ?? []) cb();
}

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
	setMeta: async (key, value) => {
		await invoke<void>("storage_set_meta", { key, value });
		notifyMeta(key);
	},
	removeMeta: async (key) => {
		await invoke<void>("storage_remove_meta", { key });
		notifyMeta(key);
	},

	// One process, one window, so "written out of context" means written by another part of THIS
	// window: the scheduled-backup tick stamps each target's run state while a Settings panel may
	// be sitting on a copy of the same list. Without this the panel's next write would put the
	// stale copy back and lose it. Same contract as the extension's chrome.storage listener; the
	// notification is just in-process, since every writer is.
	subscribeMeta(key, callback) {
		const set = metaListeners.get(key) ?? new Set();
		metaListeners.set(key, set);
		set.add(callback);
		return () => {
			set.delete(callback);
			if (set.size === 0) metaListeners.delete(key);
		};
	},
};
