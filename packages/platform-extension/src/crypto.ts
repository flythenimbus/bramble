/// <reference types="chrome" />
import type { CryptoAdapter, EncryptedPayload, MasterEncrypted } from "@core/adapters/crypto";

async function send<T = unknown>(type: string, payload?: unknown): Promise<T> {
	const res = await chrome.runtime.sendMessage({ type, payload });
	if (!res?.ok) throw new Error(res?.error ?? `crypto ${type} failed`);
	return res.data as T;
}

export const extensionCrypto: CryptoAdapter = {
	unlock: (password, saltB64) => send("CRYPTO_UNLOCK", { password, saltB64 }),
	lock: () => send("CRYPTO_LOCK"),
	isLocked: () => send<boolean>("CRYPTO_IS_LOCKED"),
	encryptEntry: (plaintextJson) => send<EncryptedPayload>("CRYPTO_ENCRYPT", { plaintextJson }),
	decryptEntry: (payload) => send<string>("CRYPTO_DECRYPT", payload),
	generateSalt: () => send<string>("CRYPTO_GEN_SALT"),
	verifierFor: async (magic) => {
		const bytes = await send<number[]>("CRYPTO_VERIFIER", { magic: Array.from(magic) });
		return new Uint8Array(bytes);
	},
	encryptWithMaster: (plaintext) => send<MasterEncrypted>("CRYPTO_ENCRYPT_OUTER", { plaintext }),
	decryptWithMaster: (iv, ciphertext) => send<string>("CRYPTO_DECRYPT_OUTER", { iv, ciphertext }),
	changePassword: (newPassword, newSaltB64, entries) =>
		send<EncryptedPayload[]>("CRYPTO_CHANGE_PW", { newPassword, newSaltB64, entries }),
};
