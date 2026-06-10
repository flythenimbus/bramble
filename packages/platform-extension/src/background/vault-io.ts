/// <reference types="chrome" />

import { decodeVaultBlob, type EncryptedEntry, type VaultBlob } from "@core/vault-format";
import { extensionStorage, PENDING_BLOB_KEY } from "../storage";
import { sendToOffscreen } from "./offscreen-client";

export function bytesToBase64(bytes: Uint8Array): string {
	let s = "";
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] ?? 0);
	return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
	const s = atob(b64);
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
}

export async function readAndDecodeVault(): Promise<VaultBlob> {
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
	await chrome.storage.session.set({
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
	let entries: EncryptedEntry[];
	if (currentBlob.entriesCiphertext.length === 0) {
		entries = [];
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
		entries = JSON.parse(decrypted.data) as EncryptedEntry[];
	}
	const mutated = await mutate(entries);
	const json = JSON.stringify(mutated);
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
		await chrome.runtime.sendMessage({ type: "VAULT_CHANGED_EXTERNAL" });
	} catch {}
}
