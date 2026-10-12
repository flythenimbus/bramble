// The seam a transport calls when a peer's entries arrive: merge them into the
// local vault and persist, skipping the write when nothing changed. The host
// supplies decrypt/encrypt/persist via VaultSyncPort, so this stays free of
// platform APIs and crypto. See docs/p2p-sync.md.

import type { CryptoAdapter } from "../adapters/crypto";
import type { EntriesBlobStore } from "../vault/entries-blob";
import type { EncryptedEntry } from "../vault-format";
import { type EntriesPayload, sanitizeRemoteEntriesPayload } from "./entries-payload";
import { entryVersionKey } from "./entry-version";
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
	/** Whether each entry decrypts under this vault's key; only the verdict leaves the crypto host. */
	openable(entries: EncryptedEntry[]): Promise<boolean[]>;
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

/** Settings as an id->stamp map, so the same comparison covers them. */
function settingsStamps(settings: EntriesPayload["settings"]): Map<string, Hlc> {
	return new Map(Object.entries(settings ?? {}).map(([key, rec]) => [key, rec.hlc]));
}

/**
 * True if both payloads hold the same entries (by id+stamp), tombstones and settings.
 *
 * Settings are part of this or they never propagate: the caller writes and re-broadcasts only
 * when a merge changed something, so a settings-only change judged equivalent would be dropped
 * on the floor and appear to sync only when it rode along with an entry edit.
 */
export function payloadsEquivalent(a: EntriesPayload, b: EntriesPayload): boolean {
	return (
		stampMapsEqual(stampMap(a.entries), stampMap(b.entries)) &&
		stampMapsEqual(stampMap(a.tombstones), stampMap(b.tombstones)) &&
		stampMapsEqual(settingsStamps(a.settings), settingsStamps(b.settings))
	);
}

/** Drop incoming entries that would win the merge but don't decrypt here: a peer can't plant another vault's entries. */
async function admit(
	port: VaultSyncPort,
	local: EntriesPayload,
	remote: EntriesPayload,
	rejected: Set<string>,
): Promise<EntriesPayload> {
	const mine = new Map(local.entries.map((e) => [e.id, e.hlc]));
	const candidates = remote.entries.filter((e) => {
		if (rejected.has(entryVersionKey(e))) return false;
		const have = mine.get(e.id);
		return have === undefined || compareHlc(e.hlc, have) > 0;
	});
	if (candidates.length > 0) {
		const verdicts = await port.openable(candidates);
		const refused = candidates.filter((_, i) => !verdicts[i]);
		for (const e of refused) rejected.add(entryVersionKey(e));
		if (refused.length > 0) {
			console.warn(`[sync] refused ${refused.length} entries that don't decrypt in this vault`);
		}
	}
	return { ...remote, entries: remote.entries.filter((e) => !rejected.has(entryVersionKey(e))) };
}

/**
 * Merge an incoming remote payload into the local vault. Writes (and so triggers
 * a re-broadcast in a mesh) only when the merge changed local state, which keeps
 * gossip from looping forever once peers converge. `rejected` remembers refused entry
 * versions across calls, so a peer's rebroadcast isn't re-checked every few seconds.
 */
export async function applyRemotePayload(
	port: VaultSyncPort,
	remote: EntriesPayload,
	{ rejected = new Set<string>() }: { rejected?: Set<string> } = {},
): Promise<ApplyResult> {
	// A peer's payload is untrusted: drop any future-dated (poisoned) stamps before merge or
	// witness, so a member can't pin an un-deletable entry by stamping it years ahead.
	const safe = sanitizeRemoteEntriesPayload(remote);
	const local = await port.readLocal();
	const admitted = await admit(port, local, safe, rejected);
	const merged = mergeEntriesPayload(local, admitted);
	const changed = !payloadsEquivalent(local, merged);
	if (changed) {
		// Only admitted stamps: a refused entry must not advance this device's clock.
		await port.witnessRemote(remoteStamps(admitted));
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
	crypto: Pick<CryptoAdapter, "decryptEntries">;
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
		openable: async (entries) =>
			(
				await deps.crypto.decryptEntries(
					entries.map(({ ciphertext, iv, wrappedDek, dekIv }) => ({
						ciphertext,
						iv,
						wrappedDek,
						dekIv,
					})),
				)
			).map((p) => p != null),
	};
}
