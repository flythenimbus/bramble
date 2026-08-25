// Every local change to a vault's entries: add, import, update, delete. Each
// mutation is a pure transition `(current, input) -> next` whose effect is the
// encrypt-and-write; it returns the next VaultEntries only after the write
// succeeds, and holds no React state, so the seam is the test surface. See
// CONTEXT.md (VaultEntries, EntryMutations) and docs/vault-format.md.

import type { AutofillAdapter } from "../adapters/autofill";
import type { CryptoAdapter } from "../adapters/crypto";
import type { StorageAdapter } from "../adapters/storage";
import type { Entry, EntryData } from "../hooks/useVault";
import type { EntriesPayload, Hlc, HybridClock } from "../sync";
import { encodeEntriesPayload } from "../sync";
import { base64ToBytes } from "../util/bytes";
import type { EncryptedEntry, VaultBlob } from "../vault-format";
import { toAutofillIndex } from "./autofill-index";
import { createEntriesBlobStore } from "./entries-blob";
import { entryDataSchema } from "./entry-normalize";
import { withPasswordChangelog } from "./password-changelog";

// Coalesce a burst of uses into one write.
const USE_COALESCE_MS = 60_000;

/**
 * The in-memory entry state of a vault: the decrypted entries plus the sync
 * bookkeeping that must travel with them for merges to converge. `stamps` maps
 * an entry id to its HLC stamp; `tombstones` maps a deleted id to the stamp of
 * its deletion.
 */
export interface VaultEntries {
	entries: Entry[];
	stamps: Map<string, Hlc>;
	tombstones: Map<string, Hlc>;
}

export interface EntryMutationsDeps {
	crypto: Pick<CryptoAdapter, "encryptEntry" | "encryptWithVek" | "decryptWithVek">;
	storage: Pick<StorageAdapter, "writeVaultBlob">;
	autofill: Pick<AutofillAdapter, "beginIndexUpdate" | "setIndex">;
	readDecodedBlob: () => Promise<{ blob: VaultBlob }>;
	/** Lazily resolves this device's HLC; mutations stamp new writes from it. */
	clock: () => Promise<HybridClock>;
}

export interface EntryMutations {
	add(current: VaultEntries, data: EntryData): Promise<VaultEntries>;
	importMany(current: VaultEntries, items: EntryData[]): Promise<VaultEntries>;
	update(current: VaultEntries, id: string, data: EntryData): Promise<VaultEntries>;
	remove(current: VaultEntries, id: string): Promise<VaultEntries>;
	/** Delete a selection in one write (not N), each id getting its own tombstone. */
	removeMany(current: VaultEntries, ids: string[]): Promise<VaultEntries>;
	/**
	 * Archive or restore a selection in one write. Archiving is an ordinary entry update,
	 * not a delete: no tombstone is written, so a restore is just the inverse call and a
	 * concurrent delete elsewhere still wins the merge.
	 */
	setArchived(current: VaultEntries, ids: string[], archived: boolean): Promise<VaultEntries>;
	/** Record a use (copy/fill): bumps only `lastUsedAt`, coalesced within USE_COALESCE_MS. */
	touch(current: VaultEntries, id: string): Promise<VaultEntries>;
	/**
	 * Re-encrypt everything under whatever key is loaded NOW and hand back the sealed entries
	 * section, writing nothing.
	 *
	 * For rotating the vault key, which has to put a new slot list and re-sealed entries into ONE
	 * blob. Writing them separately would leave a window where the slots open with the new key and
	 * the entries only with the old, and the second write would have already consumed the backup
	 * that could undo the first.
	 */
	sealAll(current: VaultEntries): Promise<{ entriesIv: Uint8Array; entriesCiphertext: Uint8Array }>;
	/** Decrypt the on-disk entries payload (empty for a fresh vault). */
	readEntriesPayload(): Promise<EntriesPayload>;
	/**
	 * Encrypt + write an entries payload under the VEK, preserving the slot list.
	 * The persist primitive shared with the sync-enrollment path; does not touch
	 * the autofill index or local state.
	 */
	writeEntriesBlob(payload: EntriesPayload): Promise<void>;
}

export function createEntryMutations(deps: EntryMutationsDeps): EntryMutations {
	const { crypto, storage, autofill, readDecodedBlob, clock } = deps;

	// The on-disk entries format lives in one place (EntriesBlobStore); these are
	// the same primitives the sync-enrollment path and mobile roster sync use.
	const { readEntriesPayload, writeEntriesBlob } = createEntriesBlobStore({
		crypto,
		storage,
		readDecodedBlob,
	});

	// Encrypt each entry under a fresh DEK and pair it with its stamp.
	const buildPayload = async (next: VaultEntries): Promise<EntriesPayload> => {
		const entries: EncryptedEntry[] = await Promise.all(
			next.entries.map(async (entry) => {
				const { id, ...data } = entry;
				const enc = await crypto.encryptEntry(JSON.stringify(data));
				const hlc = next.stamps.get(id);
				if (!hlc) throw new Error(`missing sync stamp for entry ${id}`);
				return {
					id,
					wrappedDek: enc.wrappedDek,
					dekIv: enc.dekIv,
					ciphertext: enc.ciphertext,
					iv: enc.iv,
					hlc,
				};
			}),
		);
		return { entries, tombstones: [...next.tombstones].map(([id, hlc]) => ({ id, hlc })) };
	};

	const sealAll = async (current: VaultEntries) => {
		// Both layers are re-keyed: each entry gets a fresh DEK wrapped by the loaded key, and the
		// payload holding them is sealed under it too.
		const { iv, ciphertext } = await crypto.encryptWithVek(
			encodeEntriesPayload(await buildPayload(current)),
		);
		return { entriesIv: base64ToBytes(iv), entriesCiphertext: base64ToBytes(ciphertext) };
	};

	// Persist a new state in one write, then refresh the autofill index so it can
	// never drift from disk. Returns `next` only after the write succeeds, so a
	// failed write leaves the caller's state untouched.
	const persist = async (next: VaultEntries): Promise<VaultEntries> => {
		const indexLease = await autofill.beginIndexUpdate?.();
		await writeEntriesBlob(await buildPayload(next));
		await autofill.setIndex(toAutofillIndex(next.entries), indexLease);
		return next;
	};

	// Validate at the seam (reject before encrypt), but persist the original value:
	// validation is a gate, not a transform, so forward-compat keys survive the way
	// they do on read (normalizeEntryData).
	const validate = (data: EntryData): EntryData => {
		const result = entryDataSchema.safeParse(data);
		if (!result.success) {
			// Paths only: a decrypted entry holds secrets, so never log the values.
			const paths = result.error.issues.map((i) => i.path.join(".") || "<root>").join(", ");
			throw new Error(`entry failed validation (${paths})`);
		}
		return data;
	};

	// One encrypt-and-write for the whole selection, so deleting 50 entries is a single
	// disk write and a single autofill-index rebuild, not 50 of each. Each id gets its
	// own stamp, so the tombstones stay individually comparable in a merge.
	const removeMany = async (current: VaultEntries, ids: string[]): Promise<VaultEntries> => {
		const doomed = new Set(ids);
		if (doomed.size === 0) return current;
		const c = await clock();
		const stamps = new Map(current.stamps);
		const tombstones = new Map(current.tombstones);
		for (const id of doomed) {
			stamps.delete(id);
			tombstones.set(id, c.send());
		}
		return persist({
			entries: current.entries.filter((e) => !doomed.has(e.id)),
			stamps,
			tombstones,
		});
	};

	// One write for the whole selection, like removeMany. `archivedAt` is deliberately its
	// own timestamp rather than a bump of `updatedAt`: archiving edits no content, and
	// folding it into `updatedAt` would reorder the "recently updated" sort for entries
	// nobody touched. Ids that are already in the requested state are skipped, so a
	// no-op archive doesn't rewrite (and re-encrypt) the whole vault.
	const setArchived = async (
		current: VaultEntries,
		ids: string[],
		archived: boolean,
	): Promise<VaultEntries> => {
		const wanted = new Set(ids);
		const changing = new Set(
			current.entries
				.filter((e) => wanted.has(e.id) && (e.archivedAt !== undefined) !== archived)
				.map((e) => e.id),
		);
		if (changing.size === 0) return current;
		const c = await clock();
		const stamps = new Map(current.stamps);
		const entries = current.entries.map((e) => {
			if (!changing.has(e.id)) return e;
			// hlc.wall is physical ms, so the stamp doubles as the timestamp (as in `add`).
			const hlc = c.send();
			stamps.set(e.id, hlc);
			if (archived) return { ...e, archivedAt: hlc.wall };
			const { archivedAt: _archivedAt, ...rest } = e;
			return rest as Entry;
		});
		return persist({ entries, stamps, tombstones: current.tombstones });
	};

	return {
		readEntriesPayload,
		writeEntriesBlob,

		add: async (current, data) => {
			const valid = validate(data);
			const c = await clock();
			// hlc.wall is physical ms, so it doubles as the timestamp.
			const hlc = c.send();
			// No prior entry, so this only strips a caller-supplied changelog.
			const entry = withPasswordChangelog(
				{
					id: globalThis.crypto.randomUUID(),
					...valid,
					createdAt: valid.createdAt ?? hlc.wall,
					updatedAt: hlc.wall,
				},
				undefined,
				hlc.wall,
			);
			const stamps = new Map(current.stamps);
			stamps.set(entry.id, hlc);
			return persist({
				entries: [...current.entries, entry],
				stamps,
				tombstones: current.tombstones,
			});
		},

		// One encrypt-and-write for the whole batch (not N), so a large import is a
		// single disk write.
		importMany: async (current, items) => {
			const valid = items.map(validate);
			const c = await clock();
			const stamps = new Map(current.stamps);
			const withIds: Entry[] = valid.map((data) => {
				const hlc = c.send();
				const id = globalThis.crypto.randomUUID();
				stamps.set(id, hlc);
				// Imported entries start with no changelog; an import file cannot seed one.
				return withPasswordChangelog(
					{
						id,
						...data,
						createdAt: data.createdAt ?? hlc.wall,
						updatedAt: data.updatedAt ?? hlc.wall,
					},
					undefined,
					hlc.wall,
				);
			});
			return persist({
				entries: [...current.entries, ...withIds],
				stamps,
				tombstones: current.tombstones,
			});
		},

		update: async (current, id, data) => {
			const valid = validate(data);
			const c = await clock();
			const hlc = c.send();
			const prev = current.entries.find((e) => e.id === id);
			const entries = current.entries.map((e) =>
				e.id === id
					? withPasswordChangelog(
							{
								id,
								...valid,
								// Preserve create time (backfill legacy) and last-used across the edit.
								createdAt: prev?.createdAt ?? valid.createdAt ?? hlc.wall,
								updatedAt: hlc.wall,
								lastUsedAt: valid.lastUsedAt ?? prev?.lastUsedAt,
							},
							prev,
							hlc.wall,
						)
					: e,
			);
			const stamps = new Map(current.stamps);
			stamps.set(id, hlc);
			return persist({ entries, stamps, tombstones: current.tombstones });
		},

		touch: async (current, id) => {
			const prev = current.entries.find((e) => e.id === id);
			if (!prev) return current;
			const c = await clock();
			const hlc = c.send();
			if (prev.lastUsedAt !== undefined && hlc.wall - prev.lastUsedAt < USE_COALESCE_MS) {
				return current;
			}
			const entries = current.entries.map((e) =>
				e.id === id ? { ...e, lastUsedAt: hlc.wall } : e,
			);
			const stamps = new Map(current.stamps);
			stamps.set(id, hlc);
			return persist({ entries, stamps, tombstones: current.tombstones });
		},

		// Write a tombstone so the delete survives a merge instead of being re-added
		// by a stale peer.
		remove: (current, id) => removeMany(current, [id]),

		removeMany,

		setArchived,

		sealAll,
	};
}
