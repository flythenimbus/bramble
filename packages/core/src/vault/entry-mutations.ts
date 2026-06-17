// Every local change to a vault's entries: add, import, update, delete. Each
// mutation is a pure transition `(current, input) -> next` whose effect is the
// encrypt-and-write; it returns the next VaultEntries only after the write
// succeeds, and holds no React state, so the seam is the test surface. See
// CONTEXT.md (VaultEntries, EntryMutations) and docs/vault-format.md.

import type { AutofillAdapter } from "../adapters/autofill";
import type { CryptoAdapter } from "../adapters/crypto";
import type { StorageAdapter } from "../adapters/storage";
import type { Entry, EntryData } from "../hooks/useVault";
import {
	decodeEntriesPayload,
	type EntriesPayload,
	emptyEntriesPayload,
	encodeEntriesPayload,
	type Hlc,
	type HybridClock,
} from "../sync";
import { base64ToBytes, bytesToBase64 } from "../util/bytes";
import { type EncryptedEntry, encodeVaultBlob, type VaultBlob } from "../vault-format";
import { toAutofillIndex } from "./autofill-index";
import { entryDataSchema } from "./entry-normalize";

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
	autofill: Pick<AutofillAdapter, "setIndex">;
	readDecodedBlob: () => Promise<{ blob: VaultBlob }>;
	/** Lazily resolves this device's HLC; mutations stamp new writes from it. */
	clock: () => Promise<HybridClock>;
}

export interface EntryMutations {
	add(current: VaultEntries, data: EntryData): Promise<VaultEntries>;
	importMany(current: VaultEntries, items: EntryData[]): Promise<VaultEntries>;
	update(current: VaultEntries, id: string, data: EntryData): Promise<VaultEntries>;
	remove(current: VaultEntries, id: string): Promise<VaultEntries>;
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

	const readEntriesPayload = async (): Promise<EntriesPayload> => {
		const { blob } = await readDecodedBlob();
		if (blob.entriesCiphertext.length === 0) return emptyEntriesPayload();
		const json = await crypto.decryptWithVek(
			bytesToBase64(blob.entriesIv),
			bytesToBase64(blob.entriesCiphertext),
		);
		return decodeEntriesPayload(json);
	};

	const writeEntriesBlob = async (payload: EntriesPayload): Promise<void> => {
		const { iv, ciphertext } = await crypto.encryptWithVek(encodeEntriesPayload(payload));
		const { blob } = await readDecodedBlob();
		await storage.writeVaultBlob(
			encodeVaultBlob({
				slots: blob.slots,
				entriesIv: base64ToBytes(iv),
				entriesCiphertext: base64ToBytes(ciphertext),
			}),
		);
	};

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

	// Persist a new state in one write, then refresh the autofill index so it can
	// never drift from disk. Returns `next` only after the write succeeds, so a
	// failed write leaves the caller's state untouched.
	const persist = async (next: VaultEntries): Promise<VaultEntries> => {
		await writeEntriesBlob(await buildPayload(next));
		await autofill.setIndex(toAutofillIndex(next.entries));
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

	return {
		readEntriesPayload,
		writeEntriesBlob,

		add: async (current, data) => {
			const valid = validate(data);
			const c = await clock();
			const entry: Entry = { id: globalThis.crypto.randomUUID(), ...valid };
			const stamps = new Map(current.stamps);
			stamps.set(entry.id, c.send());
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
			const withIds: Entry[] = valid.map((data) => ({
				id: globalThis.crypto.randomUUID(),
				...data,
			}));
			const stamps = new Map(current.stamps);
			for (const e of withIds) stamps.set(e.id, c.send());
			return persist({
				entries: [...current.entries, ...withIds],
				stamps,
				tombstones: current.tombstones,
			});
		},

		update: async (current, id, data) => {
			const valid = validate(data);
			const c = await clock();
			const entries = current.entries.map((e) => (e.id === id ? { id, ...valid } : e));
			const stamps = new Map(current.stamps);
			stamps.set(id, c.send());
			return persist({ entries, stamps, tombstones: current.tombstones });
		},

		// Write a tombstone so the delete survives a merge instead of being re-added
		// by a stale peer.
		remove: async (current, id) => {
			const c = await clock();
			const entries = current.entries.filter((e) => e.id !== id);
			const stamps = new Map(current.stamps);
			stamps.delete(id);
			const tombstones = new Map(current.tombstones);
			tombstones.set(id, c.send());
			return persist({ entries, stamps, tombstones });
		},
	};
}
