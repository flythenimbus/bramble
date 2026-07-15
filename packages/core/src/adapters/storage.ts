/** Persistence for the vault blob and metadata. The vault lives in the platform's own sandboxed storage (chrome.storage.local on the extension), which is readable and writable headless with no gesture. */
export interface StorageAdapter {
	// Blob methods take an optional vaultId. When omitted they resolve to the primary
	// vault (the only vault today), so single-vault call sites keep working unchanged;
	// multi-vault call sites pass an explicit id. See docs/multiple-vaults.md.
	/** True when a vault exists on this device (any vault when vaultId is omitted, else that specific one). */
	hasVaultHandle(vaultId?: string): Promise<boolean>;
	readVaultBlob(vaultId?: string): Promise<Uint8Array>;
	// Must snapshot the previous bytes into a recovery store BEFORE overwriting, so
	// a crash mid-write leaves the previous good bytes recoverable. Writing with an id
	// that is not yet registered (and no primary exists) bootstraps the first vault.
	writeVaultBlob(blob: Uint8Array, vaultId?: string): Promise<void>;
	// Restore the most recent recovery snapshot without taking a new one. Returns
	// false if there was nothing to recover. Run when readVaultBlob no longer
	// decodes (the usual signal that a write was interrupted).
	restoreVaultFromBackup(vaultId?: string): Promise<boolean>;
	getMeta<T>(key: string): Promise<T | undefined>;
	setMeta<T>(key: string, value: T): Promise<void>;
	/** Delete a metadata key (e.g. clearing `sync.group` when leaving the sync group). */
	removeMeta(key: string): Promise<void>;
	/**
	 * Subscribe to changes of a metadata key made in another context (e.g. a background
	 * scheduled backup writing `backup.targets`) so open UI can live-refresh. Returns an
	 * unsubscribe. Optional: absent where nothing writes metadata out-of-context (mobile
	 * runs backups in-process, so its own React state already reflects the write).
	 */
	subscribeMeta?(key: string, callback: () => void): () => void;
}
