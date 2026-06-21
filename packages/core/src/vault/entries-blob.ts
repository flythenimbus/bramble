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
		async writeEntriesBlob(payload) {
			const { iv, ciphertext } = await crypto.encryptWithVek(encodeEntriesPayload(payload));
			const { blob } = await readDecodedBlob();
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
