// Entries a vault can't decrypt are set aside here instead of failing the whole vault. They stay
// sealed as they arrived, are never synced or shown, and are kept until the vault is deleted, so
// a later rescue can still reach them. See docs/sync-vault-pinning-and-quarantine.md.

import type { StorageAdapter } from "../adapters/storage";
import { entryVersionKey } from "../sync/entry-version";
import type { EncryptedEntry } from "../vault-format";
import type { EntriesBlobStore } from "./entries-blob";

export type QuarantinedEntry = EncryptedEntry & { quarantinedAt: number };
/** A previous store this code couldn't read, kept raw rather than overwritten or blocking the open. */
export type UnreadableStore = { unreadableStore: string; quarantinedAt: number };
export type QuarantineRecord = QuarantinedEntry | UnreadableStore;
export type QuarantineStore = Required<Pick<StorageAdapter, "readQuarantine" | "writeQuarantine">>;

/** Set aside entries this vault can't open, then rewrite the vault without them. */
export async function quarantineEntries(
	deps: { storage: QuarantineStore; store: EntriesBlobStore; vaultId: string; now?: number },
	unreadable: EncryptedEntry[],
): Promise<void> {
	const now = deps.now ?? Date.now();
	const kept = parseStore(await deps.storage.readQuarantine(deps.vaultId), now);
	const known = new Set(kept.filter(isEntryRecord).map(entryVersionKey));
	const added = unreadable
		.filter((e) => !known.has(entryVersionKey(e)))
		.map((e) => ({ ...e, quarantinedAt: now }));
	// Store first: a failed rewrite then leaves a copy in both places, never in neither.
	if (added.length > 0) {
		await deps.storage.writeQuarantine(JSON.stringify([...kept, ...added]), deps.vaultId);
	}
	const drop = new Set(unreadable.map(entryVersionKey));
	// Re-read so a merge that landed since the load survives the rewrite.
	const current = await deps.store.readEntriesPayload();
	await deps.store.writeEntriesBlob({
		...current,
		entries: current.entries.filter((e) => !drop.has(entryVersionKey(e))),
	});
}

const isEntryRecord = (r: unknown): r is QuarantinedEntry =>
	typeof r === "object" && r !== null && "id" in r && "hlc" in r;

/** The stored records, or a damaged store carried forward whole so nothing in it is lost. */
function parseStore(raw: string | null, now: number): unknown[] {
	if (raw === null) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed)) return parsed;
	} catch {}
	return [{ unreadableStore: raw, quarantinedAt: now }];
}
