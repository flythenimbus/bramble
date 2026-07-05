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
import { extensionStorage, PENDING_BLOB_KEY } from "../storage";
import { sendToOffscreen } from "./offscreen-client";
import { witnessStamp } from "./sync-clock";

// Re-exported so existing background importers keep their import site.
export { base64ToBytes, bytesToBase64 };

/**
 * Thrown by a background vault read when the FSA file's permission is not granted.
 * The background must not `requestPermission` (it needs a gesture and throws a raw
 * "permission denied for vault file"); callers catch this and route through a gesture
 * (the popup) to grant access instead. See docs/storage.md.
 */
export class VaultAccessError extends Error {
	constructor() {
		super("vault file access not granted to the background");
		this.name = "VaultAccessError";
	}
}

export async function readAndDecodeVault(): Promise<VaultBlob> {
	// Guard before readVaultBlob so an ungranted FSA file yields a typed, catchable
	// error rather than readVaultBlob calling requestPermission from the background.
	if (!(await extensionStorage.canReadFromBackground())) throw new VaultAccessError();
	const bytes = await extensionStorage.readVaultBlob();
	return decodeVaultBlob(bytes);
}

/** chrome.storage.local writes directly; FSA queues the blob for the next popup to flush. */
export async function writeOrQueueVault(blob: Uint8Array, entryCount: number): Promise<void> {
	const canWrite = await extensionStorage.canWriteFromBackground();
	if (canWrite) {
		await extensionStorage.writeVaultBlob(blob);
		return;
	}
	await api.storage.session.set({
		[PENDING_BLOB_KEY]: {
			blobB64: bytesToBase64(blob),
			entryCount,
			queuedAt: Date.now(),
		},
	});
}

/** Decrypt, mutate, re-encrypt the outer entry list via offscreen so plaintext never leaves it. */
export async function reencryptOuterWithEntryChange(
	currentBlob: VaultBlob,
	mutate: (entries: EncryptedEntry[]) => Promise<EncryptedEntry[]>,
): Promise<{ entriesIv: Uint8Array; entriesCiphertext: Uint8Array; entryCount: number }> {
	let payload: EntriesPayload;
	if (currentBlob.entriesCiphertext.length === 0) {
		payload = emptyEntriesPayload();
	} else {
		const decrypted = await sendToOffscreen({
			type: "CRYPTO_DECRYPT_OUTER",
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
