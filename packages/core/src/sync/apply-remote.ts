// The seam a transport calls when a peer's entries arrive: merge them into the
// local vault and persist, skipping the write when nothing changed. The host
// supplies decrypt/encrypt/persist via VaultSyncPort, so this stays free of
// platform APIs and crypto. See docs/p2p-sync.md.

import type { EntriesBlobStore } from "../vault/entries-blob";
import type { EntriesPayload } from "./entries-payload";
import { compareHlc, type Hlc } from "./hlc";
import { mergeEntriesPayload } from "./vault-merge";

/** Host hooks for reading and writing the local entries payload. */
export interface VaultSyncPort {
	/** The local payload (empty for a fresh vault). Always called before writeMerged. */
	readLocal(): Promise<EntriesPayload>;
	/** Advance the local clock past these remote stamps, so future local writes sort
	 * after everything the peer has already seen. Called before writeMerged. */
	witnessRemote(stamps: Hlc[]): Promise<void>;
	/** Persist the merged payload: re-encrypt the outer blob and write it. The
	 * sealed per-entry envelopes are carried verbatim, never re-encrypted. */
	writeMerged(merged: EntriesPayload): Promise<void>;
}

/** Every stamp the remote has observed (winners and losers), for clock witnessing. */
function remoteStamps(remote: EntriesPayload): Hlc[] {
	return [...remote.entries.map((e) => e.hlc), ...remote.tombstones.map((t) => t.hlc)];
}

export interface ApplyResult {
	payload: EntriesPayload;
	/** Whether the merge actually changed local state (false = remote was redundant). */
	changed: boolean;
}

function stampMap(items: { id: string; hlc: Hlc }[]): Map<string, Hlc> {
	return new Map(items.map((i) => [i.id, i.hlc]));
}

function stampMapsEqual(a: Map<string, Hlc>, b: Map<string, Hlc>): boolean {
	if (a.size !== b.size) return false;
	for (const [id, hlc] of a) {
		const other = b.get(id);
		if (!other || compareHlc(hlc, other) !== 0) return false;
	}
	return true;
}

/** True if both payloads hold the same entries (by id+stamp) and tombstones. */
export function payloadsEquivalent(a: EntriesPayload, b: EntriesPayload): boolean {
	return (
		stampMapsEqual(stampMap(a.entries), stampMap(b.entries)) &&
		stampMapsEqual(stampMap(a.tombstones), stampMap(b.tombstones))
	);
}

/**
 * Merge an incoming remote payload into the local vault. Writes (and so triggers
 * a re-broadcast in a mesh) only when the merge changed local state, which keeps
 * gossip from looping forever once peers converge.
 */
export async function applyRemotePayload(
	port: VaultSyncPort,
	remote: EntriesPayload,
): Promise<ApplyResult> {
	const local = await port.readLocal();
	const merged = mergeEntriesPayload(local, remote);
	const changed = !payloadsEquivalent(local, merged);
	if (changed) {
		await port.witnessRemote(remoteStamps(remote));
		await port.writeMerged(merged);
	}
	return { payload: merged, changed };
}

/**
 * Build a VaultSyncPort over the shared EntriesBlobStore, so the on-disk entries
 * format has one writer across local mutations and sync merges. The host supplies
 * clock witnessing and an optional post-write notification (e.g. refresh the UI).
 */
export function createVaultSyncPort(deps: {
	store: EntriesBlobStore;
	witnessRemote: (stamps: Hlc[]) => Promise<void>;
	onChanged?: () => void | Promise<void>;
}): VaultSyncPort {
	return {
		readLocal: () => deps.store.readEntriesPayload(),
		witnessRemote: deps.witnessRemote,
		async writeMerged(merged) {
			await deps.store.writeEntriesBlob(merged);
			await deps.onChanged?.();
		},
	};
}
