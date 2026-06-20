// The CryptoAdapter method -> wasm-call mapping, declared once so every transport
// shares it: the mobile webview calls it in-process, the extension offscreen routes
// its CRYPTO_* messages through it. `getWasm` resolves the wasm module (lazily on
// mobile, the cached singleton in the offscreen). Lifecycle hooks fire on lock/unlock
// transitions; the subscription seams default to no-ops for transports (the offscreen)
// that don't surface session lifecycle. See CONTEXT.md and docs/cryptography.md.

import { base64ToBytes } from "../util/bytes";
import type { VaultCrypto } from "../wasm";
import type { CryptoAdapter } from "./crypto";

export interface CryptoAdapterHooks {
	/** Fired after a successful unlock (the VEK is now loaded). */
	onUnlocked?: () => void;
	/** Fired after lock(). */
	onLocked?: () => void;
	/** Subscription seams the CryptoAdapter must expose; default to no-ops. */
	onExternalLock?: (cb: () => void) => () => void;
	onExternalChange?: (cb: () => void) => () => void;
}

const noopSubscribe = (): (() => void) => () => {};

export function buildCryptoAdapter(
	getWasm: () => Promise<VaultCrypto>,
	hooks: CryptoAdapterHooks = {},
): CryptoAdapter {
	const { onUnlocked, onLocked } = hooks;
	return {
		async generateVek() {
			const vek = (await getWasm()).generate_vek();
			onUnlocked?.();
			return vek;
		},
		async unlockWithVek(vekB64) {
			(await getWasm()).unlock_with_vek(vekB64);
			onUnlocked?.();
		},
		async exportVek() {
			return (await getWasm()).export_vek();
		},
		async rotateVek() {
			return (await getWasm()).rotate_vek();
		},
		async lock() {
			(await getWasm()).lock();
			onLocked?.();
		},
		async isLocked() {
			return (await getWasm()).is_locked();
		},
		onExternalLock: hooks.onExternalLock ?? noopSubscribe,
		onExternalChange: hooks.onExternalChange ?? noopSubscribe,

		async generateSalt() {
			return (await getWasm()).generate_salt();
		},
		async generateSlotId() {
			return (await getWasm()).generate_slot_id();
		},

		async wrapVekPassword(i) {
			return (await getWasm()).wrap_vek_password(
				i.password,
				i.saltB64,
				i.slotIdB64,
				i.magicVersion,
			);
		},
		async unwrapVekPassword(i) {
			const ok = (await getWasm()).unwrap_vek_password(
				i.password,
				i.saltB64,
				i.slotIdB64,
				i.verifierB64,
				i.wrapIvB64,
				i.wrappedVekB64,
				i.magicVersion,
			);
			if (ok) onUnlocked?.();
			return ok;
		},
		async verifyPasswordSlot(i) {
			return (await getWasm()).verify_password_slot(
				i.password,
				i.saltB64,
				i.slotIdB64,
				i.verifierB64,
				i.magicVersion,
			);
		},

		async wrapVekWebauthn(i) {
			return (await getWasm()).wrap_vek_webauthn(i.hmacSecretB64, i.slotIdB64, i.magicVersion);
		},
		async unwrapVekWebauthn(i) {
			const ok = (await getWasm()).unwrap_vek_webauthn(
				i.hmacSecretB64,
				i.slotIdB64,
				i.verifierB64,
				i.wrapIvB64,
				i.wrappedVekB64,
				i.magicVersion,
			);
			if (ok) onUnlocked?.();
			return ok;
		},
		async verifyWebauthnSlot(i) {
			return (await getWasm()).verify_webauthn_slot(
				i.hmacSecretB64,
				i.slotIdB64,
				i.verifierB64,
				i.magicVersion,
			);
		},

		async encryptEntry(plaintextJson) {
			return (await getWasm()).encrypt_entry(plaintextJson);
		},
		async decryptEntry(p) {
			return (await getWasm()).decrypt_entry(p.ciphertext, p.iv, p.wrappedDek, p.dekIv);
		},
		async encryptWithVek(plaintext) {
			return (await getWasm()).encrypt_with_vek(plaintext);
		},
		async decryptWithVek(iv, ciphertext) {
			return (await getWasm()).decrypt_with_vek(iv, ciphertext);
		},

		async openKdbx(i) {
			const wasm = await getWasm();
			return wasm.open_kdbx4(
				base64ToBytes(i.fileB64),
				i.password,
				i.keyfileB64 ? base64ToBytes(i.keyfileB64) : undefined,
			);
		},
	};
}
