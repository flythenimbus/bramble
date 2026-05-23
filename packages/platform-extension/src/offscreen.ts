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

		default:
			throw new Error(`unknown crypto message: ${type}`);
	}
}

async function sha256Hex(text: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	const bytes = new Uint8Array(buf);
	let out = "";
	for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, "0");
	return out;
}

async function clearClipboardIfMatches(expectedHash: string): Promise<boolean> {
	let current = "";
	try {
		current = await navigator.clipboard.readText();
	} catch {
		return false;
	}
	if (!current) return false;
	const hash = await sha256Hex(current);
	if (hash !== expectedHash) return false;
	try {
		await navigator.clipboard.writeText("");
	} catch {
		return false;
	}
	return true;
}

chrome.runtime.onMessage.addListener((message: OffscreenMessage, _sender, sendResponse) => {
	if (message?.target !== "offscreen") return false;

	void (async () => {
		try {
			const msgType = message.type ?? "";
			if (msgType === "CLIPBOARD_CLEAR") {
				const expectedHash = (message.payload as { expectedHash?: string } | undefined)
					?.expectedHash;
				const cleared = expectedHash ? await clearClipboardIfMatches(expectedHash) : false;
				sendResponse({ ok: true, data: cleared });
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
