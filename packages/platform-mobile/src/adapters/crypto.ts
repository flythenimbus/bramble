import type { CryptoAdapter } from "@core/index";
import { base64ToBytes } from "@core/util/bytes";
import { loadWasm } from "../wasm-loader";

// External-lock subscribers (useVault listens here to drop decrypted state and
// bounce to the unlock screen). On mobile the trigger is the app lifecycle, not a
// background SW: see lockForLifecycle().
const lockListeners = new Set<() => void>();

/**
 * Lock the vault in response to an app-lifecycle event (backgrounded), and notify
 * subscribers so the UI re-locks. Kept separate from the plain `lock()` adapter
 * method (which useVault uses for an explicit, UI-driven lock that manages its own
 * state) so we don't double-fire onExternalLock on a manual lock.
 */
export async function lockForLifecycle(): Promise<void> {
	(await loadWasm()).lock();
	for (const fn of lockListeners) fn();
}

// Direct in-webview WASM calls. The extension routes these through an offscreen
// document over chrome.runtime; on mobile the single webview has a DOM, so the
// crypto module runs in-process and the messaging hop collapses.
export const mobileCrypto: CryptoAdapter = {
	async generateVek() {
		return (await loadWasm()).generate_vek();
	},
	async unlockWithVek(vekB64) {
		(await loadWasm()).unlock_with_vek(vekB64);
	},
	async exportVek() {
		return (await loadWasm()).export_vek();
	},
	async rotateVek() {
		return (await loadWasm()).rotate_vek();
	},
	async lock() {
		(await loadWasm()).lock();
	},
	async isLocked() {
		return (await loadWasm()).is_locked();
	},
	onExternalLock(callback) {
		lockListeners.add(callback);
		return () => lockListeners.delete(callback);
	},
	onExternalChange() {
		return () => {};
	},

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
		return (await loadWasm()).unwrap_vek_password(
			i.password,
			i.saltB64,
			i.slotIdB64,
			i.verifierB64,
			i.wrapIvB64,
			i.wrappedVekB64,
			i.magicVersion,
		);
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
		return (await loadWasm()).unwrap_vek_webauthn(
			i.hmacSecretB64,
			i.slotIdB64,
			i.verifierB64,
			i.wrapIvB64,
			i.wrappedVekB64,
			i.magicVersion,
		);
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
