/// <reference types="chrome" />
import { loadWasm, type VaultCrypto } from "./wasm-loader";

// Offscreen document: holds the WASM crypto module in a context that survives
// popup close and the service worker's idle-kill. Session state lives in the
// background SW; this page just does WASM.

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

function dispatchCrypto(crypto: VaultCrypto, type: string, payload: any): unknown {
	switch (type) {
		case "CRYPTO_LOCK":
			crypto.lock();
			return null;
		case "CRYPTO_IS_LOCKED":
			return crypto.is_locked();

		case "CRYPTO_GENERATE_VEK":
			return crypto.generate_vek();
		case "CRYPTO_UNLOCK_WITH_VEK":
			crypto.unlock_with_vek(payload.vekB64);
			return null;
		case "CRYPTO_EXPORT_VEK":
			return crypto.export_vek();
		case "CRYPTO_ROTATE_VEK":
			return crypto.rotate_vek();

		case "CRYPTO_GENERATE_SALT":
			return crypto.generate_salt();
		case "CRYPTO_GENERATE_SLOT_ID":
			return crypto.generate_slot_id();

		case "CRYPTO_WRAP_PASSWORD_SLOT":
			return crypto.wrap_vek_password(
				payload.password,
				payload.saltB64,
				payload.slotIdB64,
				new Uint8Array(payload.magicVersion),
			);
		case "CRYPTO_UNWRAP_PASSWORD_SLOT":
			return crypto.unwrap_vek_password(
				payload.password,
				payload.saltB64,
				payload.slotIdB64,
				payload.verifierB64,
				payload.wrapIvB64,
				payload.wrappedVekB64,
				new Uint8Array(payload.magicVersion),
			);
		case "CRYPTO_VERIFY_PASSWORD_SLOT":
			return crypto.verify_password_slot(
				payload.password,
				payload.saltB64,
				payload.slotIdB64,
				payload.verifierB64,
				new Uint8Array(payload.magicVersion),
			);

		case "CRYPTO_WRAP_WEBAUTHN_SLOT":
			return crypto.wrap_vek_webauthn(
				payload.hmacSecretB64,
				payload.slotIdB64,
				new Uint8Array(payload.magicVersion),
			);
		case "CRYPTO_UNWRAP_WEBAUTHN_SLOT":
			return crypto.unwrap_vek_webauthn(
				payload.hmacSecretB64,
				payload.slotIdB64,
				payload.verifierB64,
				payload.wrapIvB64,
				payload.wrappedVekB64,
				new Uint8Array(payload.magicVersion),
			);
		case "CRYPTO_VERIFY_WEBAUTHN_SLOT":
			return crypto.verify_webauthn_slot(
				payload.hmacSecretB64,
				payload.slotIdB64,
				payload.verifierB64,
				new Uint8Array(payload.magicVersion),
			);

		case "CRYPTO_ENCRYPT":
			return crypto.encrypt_entry(payload.plaintextJson);
		case "CRYPTO_DECRYPT":
			return crypto.decrypt_entry(
				payload.ciphertext,
				payload.iv,
				payload.wrappedDek,
				payload.dekIv,
			);
		case "CRYPTO_ENCRYPT_OUTER":
			return crypto.encrypt_with_vek(payload.plaintext);
		case "CRYPTO_DECRYPT_OUTER":
			return crypto.decrypt_with_vek(payload.iv, payload.ciphertext);

		case "CRYPTO_OPEN_KDBX": {
			// Foreign KeePass database decrypted entirely in WASM; only mapped
			// key/value pairs come back. Unrelated to the vault VEK.
			const file = b64ToBytes(payload.fileB64);
			const keyfile = payload.keyfileB64 ? b64ToBytes(payload.keyfileB64) : undefined;
			return crypto.open_kdbx4(file, payload.password, keyfile);
		}

		default:
			throw new Error(`unknown crypto message: ${type}`);
	}
}

// chrome.runtime messages can't carry a Uint8Array losslessly, so bytes arrive
// as base64 and are rebuilt here at the WASM boundary.
function b64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

// Clear the clipboard after the copy-timeout. We deliberately don't read it
// back to confirm it still holds our value: that would need the clipboardRead
// permission (a user-visible "read data you copy" grant we don't want on a
// password manager), so we clear unconditionally.
async function clearClipboard(): Promise<boolean> {
	try {
		await navigator.clipboard.writeText("");
		return true;
	} catch {
		return false;
	}
}

chrome.runtime.onMessage.addListener((message: OffscreenMessage, _sender, sendResponse) => {
	if (message?.target !== "offscreen") return false;

	void (async () => {
		try {
			const msgType = message.type ?? "";
			if (msgType === "CLIPBOARD_CLEAR") {
				sendResponse({ ok: true, data: await clearClipboard() });
				return;
			}
			if (!msgType.startsWith("CRYPTO_")) {
				throw new Error(`unknown message type: ${msgType}`);
			}
			const wasmCrypto = await getWasm();
			const data = dispatchCrypto(wasmCrypto, msgType, message.payload);
			sendResponse({ ok: true, data });
		} catch (err) {
			sendResponse({ ok: false, error: String(err) });
		}
	})();
	return true;
});
