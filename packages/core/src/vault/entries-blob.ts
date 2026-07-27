// The single reader/writer of the on-disk entries format for the adapter context
// (the React app and the mobile sync runtime). Outer-encrypts the EntriesPayload
// under the VEK, preserves the slot list, and encodes the vault blob — all the
// format knowledge lives here, behind a two-method interface, so EntryMutations,
// the sync-enrollment path, and the roster-sync VaultSyncPort can't each drift a
// copy. See CONTEXT.md (EntriesBlobStore). The extension *background* uses a
// different transport (offscreen IPC + a write-queue) and stays a separate writer.

import type { CryptoAdapter } from "../adapters/crypto";
import type { StorageAdapter } from "../adapters/storage";
import {
	decodeEntriesPayload,
	type EntriesPayload,
	emptyEntriesPayload,
	encodeEntriesPayload,
} from "../sync/entries-payload";
import { base64ToBytes, bytesToBase64 } from "../util/bytes";
import { encodeVaultBlob, type VaultBlob } from "../vault-format";

export interface EntriesBlobDeps {
	crypto: Pick<CryptoAdapter, "encryptWithVek" | "decryptWithVek">;
	storage: Pick<StorageAdapter, "writeVaultBlob">;
	/** The current decoded vault blob (for the slot list + outer ciphertext). */
	readDecodedBlob: () => Promise<{ blob: VaultBlob }>;
	/**
	 * Before overwriting a non-empty entries blob, confirm the loaded VEK can decrypt the one
	 * already on disk — i.e. that this key belongs to the file we're about to write.
	 *
	 * Off by default because it costs a decrypt per write and is pointless where the key can't be
	 * the wrong one. Mobile's sync store passes it: there is ONE process-global VEK there, so a
	 * writer can hold a key that no slot in the target file wraps. Writing anyway leaves slots and
	 * entries under different keys, which no password or recovery code can open (issue #27).
	 */
	verifyVekBeforeWrite?: boolean;
}

export interface EntriesBlobStore {
	/** Decrypt the on-disk entries payload (empty for a fresh vault). */
	readEntriesPayload(): Promise<EntriesPayload>;
	/** Encrypt + write an entries payload under the VEK, preserving the slot list.
	 * Does not touch the autofill index or any in-memory state. */
	writeEntriesBlob(payload: EntriesPayload): Promise<void>;
}

export function createEntriesBlobStore({
	crypto,
	storage,
	readDecodedBlob,
	verifyVekBeforeWrite = false,
}: EntriesBlobDeps): EntriesBlobStore {
	return {
		async readEntriesPayload() {
			const { blob } = await readDecodedBlob();
			if (blob.entriesCiphertext.length === 0) return emptyEntriesPayload();
			const json = await crypto.decryptWithVek(
				bytesToBase64(blob.entriesIv),
				bytesToBase64(blob.entriesCiphertext),
			);
			return decodeEntriesPayload(json);
		},
		// Order is load-bearing: read, then verify, then seal, then write. Sealing first (as this
		// did) meant the ciphertext was produced under whatever key was loaded at that moment, then
		// married to a slot list read afterwards — two independent snapshots, and nothing checked
		// they belonged together.
		async writeEntriesBlob(payload) {
			const { blob } = await readDecodedBlob();
			if (verifyVekBeforeWrite && blob.entriesCiphertext.length > 0) {
				try {
					await crypto.decryptWithVek(
						bytesToBase64(blob.entriesIv),
						bytesToBase64(blob.entriesCiphertext),
					);
				} catch {
					// The loaded key can't open what's already there, so it isn't this vault's key.
					// Abort before writing: a bad write here is unrecoverable, and refusing costs at
					// most one dropped merge (the peer rebroadcasts).
					throw new Error(
						"Refusing to write: the loaded key doesn't match this vault's existing entries.",
					);
				}
			}
			const { iv, ciphertext } = await crypto.encryptWithVek(encodeEntriesPayload(payload));
			await storage.writeVaultBlob(
				encodeVaultBlob({
					slots: blob.slots,
					entriesIv: base64ToBytes(iv),
					entriesCiphertext: base64ToBytes(ciphertext),
				}),
			);
		},
	};
}
