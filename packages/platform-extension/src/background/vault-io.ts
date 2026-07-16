/// <reference types="chrome" />

import {
	decodeEntriesPayload,
	type EntriesPayload,
	emptyEntriesPayload,
	encodeEntriesPayload,
} from "@core/sync";
import { base64ToBytes, bytesToBase64 } from "@core/util/bytes";
import { decodeVaultBlob, type EncryptedEntry, type VaultBlob } from "@core/vault-format";
import { api } from "../platform-api";
import { extensionStorage } from "../storage";
import { sendToOffscreen } from "./offscreen-client";
import { witnessStamp } from "./sync-clock";

// Re-exported so existing background importers keep their import site.
export { base64ToBytes, bytesToBase64 };

/** Read + decode a vault's outer blob. `vaultId` targets the active vault for sync; omitted falls
 * back to the primary (existing single-vault callers). */
export async function readAndDecodeVault(vaultId?: string): Promise<VaultBlob> {
	return decodeVaultBlob(await extensionStorage.readVaultBlob(vaultId));
}

/** Persist a vault's blob (`vaultId` targets the active vault; omitted = primary). chrome.storage.local
 * is always writable headless, so the write always goes straight through. */
export async function writeVault(blob: Uint8Array, vaultId?: string): Promise<void> {
	await extensionStorage.writeVaultBlob(blob, vaultId);
}

/** Decrypt, mutate, re-encrypt the outer entry list via offscreen so plaintext never leaves it.
 * `vaultId` tags the outer crypto ops so they use that vault's VEK (matching the blob read/write);
 * omitted resolves to the active vault. */
export async function reencryptOuterWithEntryChange(
	currentBlob: VaultBlob,
	mutate: (entries: EncryptedEntry[]) => Promise<EncryptedEntry[]>,
	vaultId?: string,
): Promise<{ entriesIv: Uint8Array; entriesCiphertext: Uint8Array; entryCount: number }> {
	let payload: EntriesPayload;
	if (currentBlob.entriesCiphertext.length === 0) {
		payload = emptyEntriesPayload();
	} else {
		const decrypted = await sendToOffscreen({
			type: "CRYPTO_DECRYPT_OUTER",
			vaultId,
			payload: {
				iv: bytesToBase64(currentBlob.entriesIv),
				ciphertext: bytesToBase64(currentBlob.entriesCiphertext),
			},
		});
		if (!decrypted.ok || typeof decrypted.data !== "string") {
			throw new Error(`outer decrypt failed: ${decrypted.error ?? "no data"}`);
		}
		payload = decodeEntriesPayload(decrypted.data);
	}
	// Keep the background clock ahead of every stamp already on disk.
	for (const e of payload.entries) await witnessStamp(e.hlc);
	for (const t of payload.tombstones) await witnessStamp(t.hlc);
	const mutated = await mutate(payload.entries);
	// Tombstones pass through untouched; the mutate callbacks only add/replace entries.
	const json = encodeEntriesPayload({ entries: mutated, tombstones: payload.tombstones });
	const encrypted = await sendToOffscreen({
		type: "CRYPTO_ENCRYPT_OUTER",
		vaultId,
		payload: { plaintext: json },
	});
	if (!encrypted.ok || !encrypted.data || typeof encrypted.data !== "object") {
		throw new Error(`outer encrypt failed: ${encrypted.error ?? "no data"}`);
	}
	const { iv, ciphertext } = encrypted.data as { iv: string; ciphertext: string };
	return {
		entriesIv: base64ToBytes(iv),
		entriesCiphertext: base64ToBytes(ciphertext),
		entryCount: mutated.length,
	};
}

/** Notify any open popup that the vault changed so it can re-decrypt. */
export async function broadcastVaultChanged(): Promise<void> {
	try {
		await api.runtime.sendMessage({ type: "VAULT_CHANGED_EXTERNAL" });
	} catch {}
}
