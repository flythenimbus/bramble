// Every local change to a vault's entries: add, import, update, delete. Each
// mutation is a pure transition `(current, input) -> next` whose effect is the
// encrypt-and-write; it returns the next VaultEntries only after the write
// succeeds, and holds no React state, so the seam is the test surface. See
// CONTEXT.md (VaultEntries, EntryMutations) and docs/vault-format.md.

import type { AutofillAdapter } from "../adapters/autofill";
import type { CryptoAdapter } from "../adapters/crypto";
import type { StorageAdapter } from "../adapters/storage";
import type { Entry, EntryData } from "../hooks/useVault";
import type {
	Causal,
	EntriesPayload,
	EntryConflict,
	FileManifest,
	Hlc,
	HybridClock,
	SyncedSettings,
	Versioned,
} from "../sync";
import {
	compareHlc,
	encodeEntriesPayload,
	entryConflicts,
	isAncestor,
	nextCausal,
	nextVersion,
} from "../sync";
import { base64ToBytes } from "../util/bytes";
import type { EncryptedEntry, VaultBlob } from "../vault-format";
import { toAutofillIndex } from "./autofill-index";
import { createEntriesBlobStore } from "./entries-blob";
import { entryDataSchema } from "./entry-normalize";
import { cascadeFilesForEntries, type SealedFile, withSealedFiles } from "./file-mutations";
import { withPartStamps } from "./parts";
import { withPasswordChangelog, withSupersededPasswords } from "./password-changelog";
import { normalizeTags, tagKey, tagsEqual } from "./tags";

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
	/** Causal history of each displayed version; absent for one written by an older build. */
	causal: Map<string, Causal>;
	tombstones: Map<string, Hlc>;
	/** Causal history of each tombstone; absent for one written by an older build. */
	tombstoneCausal: Map<string, Causal>;
	/**
	 * Concurrent versions not displayed, still sealed. Carried through every write like `settings`,
	 * or the next entry edit would erase them. See docs/sync-conflicts.md.
	 */
	conflicts: EncryptedEntry[];
	/**
	 * Vault-scoped settings, carried here for one reason: `buildPayload` reconstructs the whole
	 * payload from this value on every write, so anything not held here is erased by the next
	 * entry edit. Absent when the vault has none, so a payload never grows an empty map.
	 * See docs/synced-settings.md.
	 */
	settings?: SyncedSettings;
	/**
	 * The file manifest, carried for exactly the reason `settings` is: `buildPayload` rebuilds
	 * the whole payload on every write, so a manifest not held here is erased by the next entry
	 * edit. Nothing in this module mutates it; attaching and removing files is its own seam.
	 * See docs/file-attachments.md.
	 */
	manifest?: FileManifest;
}

/** A sealed attachment an import brings: on the batch's item at `item`, or on an entry the
 * vault already has (a re-import bringing the files an earlier import could not). */
export type ImportedFile = { sealed: SealedFile } & ({ item: number } | { entryId: string });

/**
 * The version an edit form opened: its stamp, history and decrypted data. Saving supersedes this
 * version, not whatever is displayed by then (docs/sync-conflicts.md, "Saving the edit form").
 */
export interface OpenedVersion extends Versioned {
	data: Entry;
}

/**
 * How a conflict resolves: the shown version, a sibling's content, or both as separate entries.
 * `superseded` is the data of every version the kept entry replaces, so its passwords can be
 * folded into the changelog instead of being lost.
 */
export type ResolveChoice =
	| { kind: "keep"; superseded: EntryData[] }
	| { kind: "use"; data: EntryData; superseded: EntryData[]; version?: Versioned }
	| { kind: "keepBoth"; data: EntryData; superseded: EntryData[] };

export interface EntryMutationsDeps {
	crypto: Pick<
		CryptoAdapter,
		"encryptEntry" | "encryptWithVek" | "decryptWithVek" | "decryptEntries"
	>;
	storage: Pick<StorageAdapter, "writeVaultBlob">;
	autofill: Pick<AutofillAdapter, "beginIndexUpdate" | "setIndex">;
	readDecodedBlob: () => Promise<{ blob: VaultBlob }>;
	/** Lazily resolves this device's HLC; mutations stamp new writes from it. */
	clock: () => Promise<HybridClock>;
}

export interface EntryMutations {
	add(current: VaultEntries, data: EntryData): Promise<VaultEntries>;
	/**
	 * Add a batch in one write, with any attachments it brings, so a batch arrives whole or not
	 * at all. Each file is already sealed into the store (see `sealAttachment`).
	 */
	importMany(
		current: VaultEntries,
		items: EntryData[],
		files?: ImportedFile[],
	): Promise<VaultEntries>;
	/**
	 * Save an edit. With `opened`, the save supersedes that version; if another one is displayed
	 * by then, that one becomes its sibling instead of being overwritten.
	 */
	update(
		current: VaultEntries,
		id: string,
		data: EntryData,
		opened?: OpenedVersion,
	): Promise<VaultEntries>;
	remove(current: VaultEntries, id: string): Promise<VaultEntries>;
	/** Delete a selection in one write (not N), each id getting its own tombstone. */
	removeMany(current: VaultEntries, ids: string[]): Promise<VaultEntries>;
	/**
	 * Archive or restore a selection in one write. Archiving is an ordinary entry update,
	 * not a delete: no tombstone is written, so a restore is just the inverse call and a
	 * concurrent delete elsewhere still wins the merge.
	 */
	setArchived(current: VaultEntries, ids: string[], archived: boolean): Promise<VaultEntries>;
	/**
	 * Add and/or remove tags across a selection in one write. `remove` is matched by tag
	 * key, so removing "work" also removes "Work". Entries whose tag list would not
	 * actually change are skipped.
	 */
	setTags(
		current: VaultEntries,
		ids: string[],
		change: { add?: string[]; remove?: string[] },
	): Promise<VaultEntries>;
	/**
	 * Resolve a conflict in one write: a new version superseding every version held for the entry,
	 * siblings and tombstone alike. `keepBoth` also adds the sibling's content as a new entry.
	 */
	resolve(current: VaultEntries, id: string, choice: ResolveChoice): Promise<VaultEntries>;
	/**
	 * Record a use (copy/fill): bumps only `lastUsedAt`, coalesced within USE_COALESCE_MS. The
	 * entry keeps its sync stamp, so the new `lastUsedAt` stays on this device until its next edit.
	 */
	touch(current: VaultEntries, id: string): Promise<VaultEntries>;
	/** Save a re-checked breach status on a login. Not restamped, like `touch`: it is derived, per-device data. */
	setBreach(
		current: VaultEntries,
		id: string,
		breach: { leaked: boolean; checkedAt: number },
	): Promise<VaultEntries>;
	/**
	 * Write one vault-scoped setting, stamped from this device's clock.
	 *
	 * `null` clears it, and is recorded as a stamped null rather than by removing the key:
	 * absence is what a client predating the settings map produces when it strips the payload, so
	 * it cannot also mean "the user turned this off". See docs/synced-settings.md.
	 */
	setSetting(current: VaultEntries, key: string, value: unknown | null): Promise<VaultEntries>;
	/**
	 * Re-encrypt everything under whatever key is loaded NOW and hand back the sealed entries
	 * section, writing nothing.
	 *
	 * For rotating the vault key, which has to put a new slot list and re-sealed entries into ONE
	 * blob. Writing them separately would leave a window where the slots open with the new key and
	 * the entries only with the old, and the second write would have already consumed the backup
	 * that could undo the first.
	 */
	sealAll(
		current: VaultEntries,
		conflictPlaintexts: readonly (string | null)[],
	): Promise<{ entriesIv: Uint8Array; entriesCiphertext: Uint8Array; conflicts: EncryptedEntry[] }>;
	/**
	 * The plaintext of each conflict, in order, or null for one that won't open. Rotation calls
	 * this while the old key still exists and hands the result to `sealAll`.
	 */
	openConflicts(current: VaultEntries): Promise<(string | null)[]>;
	/**
	 * Encrypt + write a whole VaultEntries in one go, then refresh the autofill index.
	 *
	 * Exposed so FileMutations writes through the SAME path rather than opening a second one:
	 * the index can then never drift from disk, whichever kind of change caused the write.
	 */
	persist(next: VaultEntries): Promise<VaultEntries>;
	/** Decrypt the on-disk entries payload (empty for a fresh vault). */
	readEntriesPayload(): Promise<EntriesPayload>;
	/**
	 * Encrypt + write an entries payload under the VEK, preserving the slot list.
	 * The persist primitive shared with the sync-enrollment path; does not touch
	 * the autofill index or local state.
	 */
	writeEntriesBlob(payload: EntriesPayload): Promise<void>;
}

/** A vault with no entries, no history and no conflicts. */
export function emptyVaultEntries(): VaultEntries {
	return {
		entries: [],
		stamps: new Map(),
		causal: new Map(),
		tombstones: new Map(),
		tombstoneCausal: new Map(),
		conflicts: [],
	};
}

const causalFrom = (v: Versioned): Causal | undefined =>
	v.vv ? (v.floor ? { vv: v.vv, floor: v.floor } : { vv: v.vv }) : undefined;

/** The in-memory state for a payload; only entries that decrypted get a stamp. */
export function vaultEntriesFromPayload(payload: EntriesPayload, decrypted: Entry[]): VaultEntries {
	const ids = new Set(decrypted.map((e) => e.id));
	const shown = payload.entries.filter((e) => ids.has(e.id));
	const causal = new Map<string, Causal>();
	for (const e of shown) {
		const c = causalFrom(e);
		if (c) causal.set(e.id, c);
	}
	const tombstoneCausal = new Map<string, Causal>();
	for (const t of payload.tombstones) {
		const c = causalFrom(t);
		if (c) tombstoneCausal.set(t.id, c);
	}
	const state: VaultEntries = {
		entries: decrypted,
		stamps: new Map(shown.map((e) => [e.id, e.hlc])),
		causal,
		tombstones: new Map(payload.tombstones.map((t) => [t.id, t.hlc])),
		tombstoneCausal,
		conflicts: payload.conflicts ?? [],
	};
	if (payload.settings) state.settings = payload.settings;
	if (payload.files || payload.fileTombstones || payload.fileCascades) {
		state.manifest = {
			files: payload.files,
			fileTombstones: payload.fileTombstones,
			fileCascades: payload.fileCascades,
		};
	}
	return state;
}

const displayedOf = (s: VaultEntries, id: string): Versioned | undefined => {
	const hlc = s.stamps.get(id);
	return hlc ? { hlc, ...s.causal.get(id) } : undefined;
};

const tombstoneOf = (s: VaultEntries, id: string): Versioned | undefined => {
	const hlc = s.tombstones.get(id);
	return hlc ? { hlc, ...s.tombstoneCausal.get(id) } : undefined;
};

/** Every version held for an id: displayed, siblings and tombstone. */
function heldFor(s: VaultEntries, id: string): Versioned[] {
	const shown = displayedOf(s, id);
	const tomb = tombstoneOf(s, id);
	return [
		...(shown ? [shown] : []),
		...s.conflicts.filter((e) => e.id === id),
		...(tomb ? [tomb] : []),
	];
}

/** The displayed version of an id with its data, as withPartStamps compares against. */
function priorOf(s: VaultEntries, id: string): { data: EntryData; version: Versioned } | undefined {
	const data = s.entries.find((e) => e.id === id);
	const version = displayedOf(s, id);
	return data && version ? { data, version } : undefined;
}

/** An edit's stamp and history: it supersedes only the displayed version, so it may fork. */
function editVersion(s: VaultEntries, id: string, hlc: Hlc): { hlc: Hlc; causal: Causal } {
	const shown = displayedOf(s, id);
	return nextVersion({ hlc, bases: shown ? [shown] : [], held: heldFor(s, id) });
}

/** Each displayed entry with siblings or a concurrent delete, from the in-memory state. */
export function conflictsOf(s: VaultEntries): Map<string, EntryConflict> {
	const index = (m: Map<string, Hlc>, causal: Map<string, Causal>) =>
		[...m].map(([id, hlc]) => ({ id, hlc, ...causal.get(id) }));
	return entryConflicts({
		entries: index(s.stamps, s.causal),
		conflicts: s.conflicts,
		tombstones: index(s.tombstones, s.tombstoneCausal),
	});
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
					...next.causal.get(id),
				};
			}),
		);
		const tombstones = [...next.tombstones].map(([id, hlc]) => ({
			id,
			hlc,
			...next.tombstoneCausal.get(id),
		}));
		// Threaded through rather than rebuilt: this is the seam where a synced setting, a sibling
		// version or a file manifest would otherwise be dropped by an ordinary entry edit. Each is
		// emitted only when it has content, so a vault that has none keeps the payload shape it has.
		const payload: EntriesPayload = { entries, tombstones };
		if (next.settings) payload.settings = next.settings;
		if (next.conflicts.length > 0) payload.conflicts = next.conflicts;
		if (next.manifest?.files?.length) payload.files = next.manifest.files;
		if (next.manifest?.fileTombstones?.length)
			payload.fileTombstones = next.manifest.fileTombstones;
		if (next.manifest?.fileCascades?.length) payload.fileCascades = next.manifest.fileCascades;
		return payload;
	};

	const openConflicts = (current: VaultEntries) =>
		crypto.decryptEntries(
			current.conflicts.map(({ ciphertext, iv, wrappedDek, dekIv }) => ({
				ciphertext,
				iv,
				wrappedDek,
				dekIv,
			})),
		);

	const sealAll = async (current: VaultEntries, conflictPlaintexts: readonly (string | null)[]) => {
		// Both layers are re-keyed: each entry gets a fresh DEK wrapped by the loaded key, and the
		// payload holding them is sealed under it too.
		const payload = await buildPayload(current);
		if (payload.conflicts) {
			payload.conflicts = await Promise.all(
				payload.conflicts.map(async (e, i) => {
					const plaintext = conflictPlaintexts[i];
					// One that already wouldn't open is carried as it was; re-keying can't lose it further.
					if (plaintext == null) return e;
					const enc = await crypto.encryptEntry(plaintext);
					return { ...e, ...enc };
				}),
			);
		}
		const { iv, ciphertext } = await crypto.encryptWithVek(encodeEntriesPayload(payload));
		// The re-sealed siblings too: the caller's in-memory copies are still under the old key.
		return {
			entriesIv: base64ToBytes(iv),
			entriesCiphertext: base64ToBytes(ciphertext),
			conflicts: payload.conflicts ?? [],
		};
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
		const causal = new Map(current.causal);
		const tombstones = new Map(current.tombstones);
		const tombstoneCausal = new Map(current.tombstoneCausal);
		for (const id of doomed) {
			const hlc = c.send();
			// Supersedes every version this device holds: deleting the entry you see deletes it.
			const held = heldFor(current, id);
			stamps.delete(id);
			causal.delete(id);
			tombstones.set(id, hlc);
			tombstoneCausal.set(id, nextCausal({ hlc, bases: held, held }));
		}
		// Deleting an entry takes its attachments: each one held here is marked, and hidden while
		// the entry is gone. A file attached elsewhere that this delete never saw is not.
		return persist({
			...current,
			entries: current.entries.filter((e) => !doomed.has(e.id)),
			stamps,
			causal,
			tombstones,
			tombstoneCausal,
			conflicts: current.conflicts.filter((e) => !doomed.has(e.id)),
			manifest: cascadeFilesForEntries(current, doomed, () => c.send()),
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
		const causal = new Map(current.causal);
		const entries = current.entries.map((e) => {
			if (!changing.has(e.id)) return e;
			// hlc.wall is physical ms, so the stamp doubles as the timestamp (as in `add`).
			const hlc = c.send();
			const version = editVersion(current, e.id, hlc);
			stamps.set(e.id, version.hlc);
			causal.set(e.id, version.causal);
			const { archivedAt: _archivedAt, ...rest } = e;
			const next = archived ? { ...e, archivedAt: hlc.wall } : (rest as Entry);
			return withPartStamps(next, priorOf(current, e.id), version.hlc);
		});
		return persist({ ...current, entries, stamps, causal });
	};

	// One write for the selection, like setArchived. Tags are not content in the sense
	// `update` means: tagging fifty entries should not float all fifty to the top of
	// "recently updated", so `updatedAt` is left alone here. (Editing tags through the
	// entry form still goes via `update` and bumps it, because that saves the whole entry.)
	const setTags = async (
		current: VaultEntries,
		ids: string[],
		change: { add?: string[]; remove?: string[] },
	): Promise<VaultEntries> => {
		const add = normalizeTags(change.add) ?? [];
		const removeKeys = new Set((change.remove ?? []).map(tagKey).filter(Boolean));
		if (add.length === 0 && removeKeys.size === 0) return current;

		const wanted = new Set(ids);
		// Resolved up front so the map below is a pure application of an already-decided
		// change, and so an all-no-op call returns before touching the clock.
		const changed = new Map<string, string[] | undefined>();
		for (const entry of current.entries) {
			if (!wanted.has(entry.id)) continue;
			const kept = (entry.tags ?? []).filter((t) => !removeKeys.has(tagKey(t)));
			// Re-normalizing the concatenation is what makes adding an existing tag a no-op
			// (dedupe by key) rather than a second copy of it.
			const next = normalizeTags([...kept, ...add]);
			if (!tagsEqual(entry.tags, next)) changed.set(entry.id, next);
		}
		if (changed.size === 0) return current;

		const c = await clock();
		const stamps = new Map(current.stamps);
		const causal = new Map(current.causal);
		const entries = current.entries.map((entry) => {
			if (!changed.has(entry.id)) return entry;
			const version = editVersion(current, entry.id, c.send());
			stamps.set(entry.id, version.hlc);
			causal.set(entry.id, version.causal);
			const tags = changed.get(entry.id);
			// Dropped, not set to empty: an entry with no tags carries no key at all.
			const { tags: _tags, ...rest } = entry;
			const next = tags === undefined ? (rest as Entry) : { ...entry, tags };
			return withPartStamps(next, priorOf(current, entry.id), version.hlc);
		});
		return persist({ ...current, entries, stamps, causal });
	};

	return {
		readEntriesPayload,
		persist,
		writeEntriesBlob,

		add: async (current, data) => {
			const valid = validate(data);
			const c = await clock();
			// hlc.wall is physical ms, so it doubles as the timestamp.
			const hlc = c.send();
			// No prior entry, so this only strips a caller-supplied changelog and part stamps.
			const entry = withPartStamps(
				withPasswordChangelog(
					{
						id: globalThis.crypto.randomUUID(),
						...valid,
						createdAt: valid.createdAt ?? hlc.wall,
						updatedAt: hlc.wall,
					},
					undefined,
					hlc.wall,
				),
				undefined,
				hlc,
			);
			const stamps = new Map(current.stamps);
			stamps.set(entry.id, hlc);
			const causal = new Map(current.causal);
			causal.set(entry.id, nextCausal({ hlc, bases: [], held: [] }));
			return persist({
				...current,
				entries: [...current.entries, entry],
				stamps,
				causal,
			});
		},

		// One encrypt-and-write for the whole batch (not N), so a large import is a
		// single disk write.
		importMany: async (current, items, files = []) => {
			const valid = items.map(validate);
			const c = await clock();
			const stamps = new Map(current.stamps);
			const causal = new Map(current.causal);
			const withIds: Entry[] = valid.map((data) => {
				const hlc = c.send();
				const id = globalThis.crypto.randomUUID();
				stamps.set(id, hlc);
				causal.set(id, nextCausal({ hlc, bases: [], held: [] }));
				// Imported entries start with no changelog or part stamps; an import file cannot seed them.
				return withPartStamps(
					withPasswordChangelog(
						{
							id,
							...data,
							createdAt: data.createdAt ?? hlc.wall,
							updatedAt: data.updatedAt ?? hlc.wall,
						},
						undefined,
						hlc.wall,
					),
					undefined,
					hlc,
				);
			});
			const known = new Set(current.entries.map((e) => e.id));
			const placed = files.map(({ sealed, ...on }) => {
				const entryId = "item" in on ? withIds[on.item]?.id : on.entryId;
				// An attachment with nowhere to go would be listed and never shown: refuse the batch.
				if (entryId === undefined || ("entryId" in on && !known.has(entryId))) {
					throw new Error("an attachment's entry is not in the vault");
				}
				return { sealed, entryId };
			});
			return persist({
				...current,
				entries: [...current.entries, ...withIds],
				stamps,
				causal,
				manifest:
					placed.length > 0 ? withSealedFiles(current, placed, () => c.send()) : current.manifest,
			});
		},

		update: async (current, id, data, opened) => {
			if (opened && opened.data.id !== id) {
				throw new Error("the version this edit opened belongs to another entry");
			}
			const valid = validate(data);
			const c = await clock();
			const hlc = c.send();
			const shown = current.entries.find((e) => e.id === id);
			const displayed = displayedOf(current, id);
			const from =
				opened && displayed && compareHlc(opened.hlc, displayed.hlc) !== 0 ? opened : undefined;
			const prev = from ? from.data : shown;
			const version = from
				? nextVersion({ hlc, bases: [from], held: heldFor(current, id) })
				: editVersion(current, id, hlc);
			let conflicts = current.conflicts;
			if (from && shown && displayed) {
				// What is displayed now came in after the form opened: it stays, as a sibling.
				const { id: _id, ...shownData } = shown;
				const enc = await crypto.encryptEntry(JSON.stringify(shownData));
				const save = { hlc: version.hlc, ...version.causal };
				conflicts = [
					...conflicts.filter((e) => e.id !== id || !isAncestor(e, save)),
					{ id, ...enc, ...displayed },
				];
			}
			const entries = current.entries.map((e) =>
				e.id === id
					? withPartStamps(
							withPasswordChangelog(
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
							),
							from ? { data: from.data, version: from } : priorOf(current, id),
							version.hlc,
						)
					: e,
			);
			const stamps = new Map(current.stamps);
			stamps.set(id, version.hlc);
			const causal = new Map(current.causal);
			causal.set(id, version.causal);
			return persist({ ...current, entries, stamps, causal, conflicts });
		},

		resolve: async (current, id, choice) => {
			const prev = current.entries.find((e) => e.id === id);
			if (!prev) return current;
			const c = await clock();
			const hlc = c.send();
			const held = heldFor(current, id);
			const stamps = new Map(current.stamps);
			const causal = new Map(current.causal);
			stamps.set(id, hlc);
			causal.set(id, nextCausal({ hlc, bases: held, held }));
			// Every version the resolution chose against; keeping both, the copied one too. Over a
			// delete, the deleted state too: everything kept is restored now, not by the old write.
			const against = [
				...choice.superseded,
				...(choice.kind === "keepBoth" ? [choice.data] : []),
				...(current.tombstones.has(id) ? [{ type: prev.type } as EntryData] : []),
			];
			// The kept content keeps its part stamps except where a version it replaces disagreed.
			let entries = current.entries.map((e) =>
				e.id === id
					? withPartStamps(
							withSupersededPasswords(e, choice.superseded, hlc.wall),
							priorOf(current, id),
							hlc,
							against,
						)
					: e,
			);
			if (choice.kind === "use") {
				const valid = validate(choice.data);
				// The same changelog rule as an edit: the shown password becomes history.
				const used = withPasswordChangelog(
					{
						id,
						...valid,
						createdAt: prev.createdAt ?? valid.createdAt ?? hlc.wall,
						updatedAt: hlc.wall,
						lastUsedAt: valid.lastUsedAt ?? prev.lastUsedAt,
					},
					prev,
					hlc.wall,
				);
				// Stamped against the sibling whose content it takes, so that content keeps its stamps.
				const from = choice.version ? { data: choice.data, version: choice.version } : undefined;
				entries = entries.map((e) =>
					e.id === id
						? withPartStamps(
								withSupersededPasswords(used, choice.superseded, hlc.wall),
								from,
								hlc,
								against,
							)
						: e,
				);
			}
			if (choice.kind === "keepBoth") {
				const valid = validate(choice.data);
				const copyHlc = c.send();
				const copyId = globalThis.crypto.randomUUID();
				// The sibling is its own prior version, so its changelog carries over.
				const copy = withPartStamps(
					withPasswordChangelog(
						{
							id: copyId,
							...valid,
							createdAt: valid.createdAt ?? copyHlc.wall,
							updatedAt: copyHlc.wall,
						},
						{ id: copyId, ...valid },
						copyHlc.wall,
					),
					undefined,
					copyHlc,
				);
				stamps.set(copyId, copyHlc);
				causal.set(copyId, nextCausal({ hlc: copyHlc, bases: [], held: [] }));
				entries = [...entries, copy];
			}
			return persist({
				...current,
				entries,
				stamps,
				causal,
				conflicts: current.conflicts.filter((e) => e.id !== id),
			});
		},

		setSetting: async (current, key, value) => {
			const c = await clock();
			const settings: SyncedSettings = { ...current.settings, [key]: { hlc: c.send(), value } };
			// Entries are untouched, so this rides the same single-write persist as any mutation
			// rather than opening a second writer onto the blob.
			return persist({ ...current, settings });
		},

		touch: async (current, id) => {
			const prev = current.entries.find((e) => e.id === id);
			if (!prev) return current;
			const at = (await clock()).send().wall;
			if (prev.lastUsedAt !== undefined && at - prev.lastUsedAt < USE_COALESCE_MS) {
				return current;
			}
			// Not restamped: a use must never outrank an edit made on another device.
			const entries = current.entries.map((e) => (e.id === id ? { ...e, lastUsedAt: at } : e));
			return persist({ ...current, entries });
		},

		setBreach: async (current, id, breach) => {
			if (!current.entries.some((e) => e.id === id && e.type === "login")) return current;
			const entries = current.entries.map((e) =>
				e.id === id && e.type === "login" ? { ...e, breach } : e,
			);
			return persist({ ...current, entries });
		},

		// Write a tombstone so the delete survives a merge instead of being re-added
		// by a stale peer.
		remove: (current, id) => removeMany(current, [id]),

		removeMany,

		setArchived,

		setTags,

		sealAll,

		openConflicts,
	};
}
