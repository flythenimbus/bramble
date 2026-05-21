/// <reference types="chrome" />
import { loadWasm, type VaultCrypto } from "./wasm-loader";

let wasm: VaultCrypto | null = null;

async function getWasm(): Promise<VaultCrypto> {
	if (!wasm) wasm = await loadWasm();
	return wasm;
}

interface OffscreenMessage {
	target?: string;
	type?: string;
	payload?: any;
}

function dispatch(crypto: VaultCrypto, type: string, payload: any): unknown {
	switch (type) {
		case "CRYPTO_UNLOCK":
			crypto.unlock(payload.password, payload.saltB64);
			return null;
		case "CRYPTO_LOCK":
			crypto.lock();
			return null;
		case "CRYPTO_IS_LOCKED":
			return crypto.is_locked();
		case "CRYPTO_GEN_SALT":
			return crypto.generate_salt();
		case "CRYPTO_ENCRYPT":
			return crypto.encrypt_entry(payload.plaintextJson);
		case "CRYPTO_DECRYPT":
			return crypto.decrypt_entry(
				payload.ciphertext,
				payload.iv,
				payload.wrappedDek,
				payload.dekIv,
			);
		case "CRYPTO_VERIFIER":
			return Array.from(crypto.verifier_for(new Uint8Array(payload.magic)));
		case "CRYPTO_ENCRYPT_OUTER":
			return crypto.encrypt_with_master(payload.plaintext);
		case "CRYPTO_DECRYPT_OUTER":
			return crypto.decrypt_with_master(payload.iv, payload.ciphertext);
		case "CRYPTO_CHANGE_PW":
			return crypto.change_password(payload.newPassword, payload.newSaltB64, payload.entries);
		default:
			throw new Error(`unknown crypto message: ${type}`);
	}
}

chrome.runtime.onMessage.addListener((message: OffscreenMessage, _sender, sendResponse) => {
	if (message?.target !== "offscreen") return false;

	void (async () => {
		try {
			const crypto = await getWasm();
			const data = dispatch(crypto, message.type ?? "", message.payload);
			sendResponse({ ok: true, data });
		} catch (err) {
			sendResponse({ ok: false, error: String(err) });
		}
	})();
	return true;
});
