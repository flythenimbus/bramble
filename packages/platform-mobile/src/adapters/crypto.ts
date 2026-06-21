import type { CryptoAdapter } from "@core/index";
import { base64ToBytes } from "@core/util/bytes";
import { loadWasm } from "../wasm-loader";
import { markLocked, markUnlocked, onExternalChange, onExternalLock } from "./vault-session";

// Direct in-webview WASM calls. The extension routes these through an offscreen
// document over chrome.runtime; on mobile the single webview has a DOM, so the
// crypto module runs in-process and the messaging hop collapses. Lock/unlock
// transitions are reported to the vault-session seam (markLocked/markUnlocked);
// the session owns the subscriber machinery.
export const mobileCrypto: CryptoAdapter = {
	async generateVek() {
		const vek = (await loadWasm()).generate_vek();
		markUnlocked();
		return vek;
	},
	async unlockWithVek(vekB64) {
		(await loadWasm()).unlock_with_vek(vekB64);
		markUnlocked();
	},
	async exportVek() {
		return (await loadWasm()).export_vek();
	},
	async rotateVek() {
		return (await loadWasm()).rotate_vek();
	},
	async lock() {
		(await loadWasm()).lock();
		markLocked();
	},
	async isLocked() {
		return (await loadWasm()).is_locked();
	},
	onExternalLock,
	onExternalChange,

	async generateSalt() {
		return (await loadWasm()).generate_salt();
	},
	async generateSlotId() {
		return (await loadWasm()).generate_slot_id();
	},

	async wrapVekPassword(i) {
		return (await loadWasm()).wrap_vek_password(i.password, i.saltB64, i.slotIdB64, i.magicVersion);
	},
	async unwrapVekPassword(i) {
		const ok = (await loadWasm()).unwrap_vek_password(
			i.password,
			i.saltB64,
			i.slotIdB64,
			i.verifierB64,
			i.wrapIvB64,
			i.wrappedVekB64,
			i.magicVersion,
		);
		if (ok) markUnlocked(); // VEK now loaded => unlocked
		return ok;
	},
	async verifyPasswordSlot(i) {
		return (await loadWasm()).verify_password_slot(
			i.password,
			i.saltB64,
			i.slotIdB64,
			i.verifierB64,
			i.magicVersion,
		);
	},

	async wrapVekWebauthn(i) {
		return (await loadWasm()).wrap_vek_webauthn(i.hmacSecretB64, i.slotIdB64, i.magicVersion);
	},
	async unwrapVekWebauthn(i) {
		const ok = (await loadWasm()).unwrap_vek_webauthn(
			i.hmacSecretB64,
			i.slotIdB64,
			i.verifierB64,
			i.wrapIvB64,
			i.wrappedVekB64,
			i.magicVersion,
		);
		if (ok) markUnlocked(); // VEK now loaded => unlocked
		return ok;
	},
	async verifyWebauthnSlot(i) {
		return (await loadWasm()).verify_webauthn_slot(
			i.hmacSecretB64,
			i.slotIdB64,
			i.verifierB64,
			i.magicVersion,
		);
	},

	async encryptEntry(plaintextJson) {
		return (await loadWasm()).encrypt_entry(plaintextJson);
	},
	async decryptEntry(p) {
		return (await loadWasm()).decrypt_entry(p.ciphertext, p.iv, p.wrappedDek, p.dekIv);
	},
	async encryptWithVek(plaintext) {
		return (await loadWasm()).encrypt_with_vek(plaintext);
	},
	async decryptWithVek(iv, ciphertext) {
		return (await loadWasm()).decrypt_with_vek(iv, ciphertext);
	},

	async openKdbx(i) {
		const wasm = await loadWasm();
		return wasm.open_kdbx4(
			base64ToBytes(i.fileB64),
			i.password,
			i.keyfileB64 ? base64ToBytes(i.keyfileB64) : undefined,
		);
	},
};
