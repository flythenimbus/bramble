/** Persistence for the vault blob and metadata, plus the background corner-prompt queue-and-flush path. */
export interface StorageAdapter {
	hasVaultHandle(): Promise<boolean>;
	selectVaultFile(mode: "create" | "open"): Promise<void>;
	// Ensure the vault file is readable/writable, prompting for FSA permission if
	// needed. MUST be called from within a user gesture (the permission request
	// requires transient activation). No-op for the chrome.storage backend.
	requestVaultAccess(): Promise<void>;
	readVaultBlob(): Promise<Uint8Array>;
	// Must snapshot the on-disk bytes into a recovery store BEFORE truncating, so
	// a crash mid-write leaves the previous good bytes recoverable.
	writeVaultBlob(blob: Uint8Array): Promise<void>;
	// Restore the most recent recovery snapshot without taking a new one. Returns
	// false if there was nothing to recover. Run when readVaultBlob no longer
	// decodes (the usual signal that a write was interrupted).
	restoreVaultFromBackup(): Promise<boolean>;
	getMeta<T>(key: string): Promise<T | undefined>;
	setMeta<T>(key: string, value: T): Promise<void>;
	/** Delete a metadata key (e.g. clearing `sync.group` when leaving the sync group). */
	removeMeta(key: string): Promise<void>;

	// True iff the background can call writeVaultBlob directly. FSA = false (its
	// createWritable needs a user gesture the background lacks), so for FSA the
	// background stashes bytes in chrome.storage.session for the next popup to flush.
	canWriteFromBackground(): Promise<boolean>;
	// Flush any pending blob to disk and clear the stash. Returns true iff a flush
	// happened. Safe on every popup mount/unlock: a no-op when the queue is empty.
	flushPendingVaultBlob(): Promise<boolean>;
	// Entries in the pending blob (0 when no stash); drives the "n pending sync" chip.
	getPendingFlushCount(): Promise<number>;
}
