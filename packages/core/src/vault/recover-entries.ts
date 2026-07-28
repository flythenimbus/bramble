// Verified snapshot recovery for an entries blob that won't decrypt.
//
// Issue #27: a vault whose slots and entries ended up sealed under different keys DECODES fine —
// it fails later, on the outer AEAD — and both the master password and the recovery code hit that
// same wall, because they wrap the same key. The blob writer snapshots the previous bytes before
// truncating, so the copy from before the bad write is usually still good.
//
// Pure and adapter-shaped so it can be tested directly: every unlock path (password, recovery
// code, security key, biometric) reaches it through loadEntries.

import type { CryptoAdapter } from "../adapters/crypto";
import type { StorageAdapter } from "../adapters/storage";
import { bytesToBase64 } from "../util/bytes";
import { decodeVaultBlob, type VaultBlob } from "../vault-format";

export interface RecoverEntriesDeps {
	crypto: Pick<CryptoAdapter, "decryptWithVek">;
	storage: Pick<StorageAdapter, "restoreVaultFromBackup"> &
		Partial<Pick<StorageAdapter, "readVaultBackup">>;
	/** Reported when a snapshot is actually used, so the swap is never silent. */
	onRestored?: () => void;
}

const outer = (crypto: RecoverEntriesDeps["crypto"], blob: VaultBlob) =>
	crypto.decryptWithVek(bytesToBase64(blob.entriesIv), bytesToBase64(blob.entriesCiphertext));

/**
 * Decrypt the outer entries payload, falling back to the recovery snapshot when the live blob
 * won't open under the key already held.
 *
 * The snapshot must PROVE itself first: restoring is destructive (it overwrites the live file,
 * which is the user's only other copy), so a snapshot that is equally unopenable, unreadable, or
 * absent leaves everything untouched and the original error is rethrown unchanged.
 */
export async function decryptEntriesOrRecover(
	{ crypto, storage, onRestored }: RecoverEntriesDeps,
	blob: VaultBlob,
): Promise<string> {
	try {
		return await outer(crypto, blob);
	} catch (err) {
		if (!storage.readVaultBackup) throw err; // no snapshot store on this platform
		let recovered: string | null = null;
		try {
			const bytes = await storage.readVaultBackup();
			if (bytes) {
				const snapshot = decodeVaultBlob(bytes);
				// An empty snapshot proves nothing and would silently blank the vault.
				if (snapshot.entriesCiphertext.length > 0) recovered = await outer(crypto, snapshot);
			}
		} catch {
			recovered = null; // unreadable, undecodable, or equally unopenable
		}
		if (recovered === null) throw err;
		onRestored?.();
		await storage.restoreVaultFromBackup();
		return recovered;
	}
}
