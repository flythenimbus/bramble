// The CryptoAdapter method -> wasm-call mapping, declared once so every transport
// shares it: the mobile webview calls it in-process, the extension offscreen routes
// its CRYPTO_* messages through it. `getWasm` resolves the wasm module (lazily on
// mobile, the cached singleton in the offscreen). Lifecycle hooks fire on lock/unlock
// transitions; the subscription seams default to no-ops for transports (the offscreen)
// that don't surface session lifecycle. See CONTEXT.md and docs/cryptography.md.

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
			// `await` the call itself (not just the module): the native plugin returns
			// a promise, and the hook must fire only after the VEK is actually loaded.
			const vek = await (await getWasm()).generate_vek();
			onUnlocked?.();
			return vek;
		},
		async unlockWithVek(vekB64) {
			await (await getWasm()).unlock_with_vek(vekB64);
			onUnlocked?.();
		},
		async exportVek() {
			return (await getWasm()).export_vek();
		},
		async rotateVek() {
			return (await getWasm()).rotate_vek();
		},
		async lock() {
			await (await getWasm()).lock();
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
			const ok = await (await getWasm()).unwrap_vek_password(
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
			const ok = await (await getWasm()).unwrap_vek_webauthn(
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
		async decryptEntries(ps) {
			const m = await getWasm();
			// Native (mobile) exposes a batch that loops in-process and returns every
			// entry in a single bridge call — the big win over one call per entry. The
			// wasm module has no such method, so fall back to a per-entry loop; it runs
			// in-process there anyway, so there are no round-trips to save.
			if (m.decrypt_entries) return m.decrypt_entries(ps);
			return Promise.all(ps.map((p) => m.decrypt_entry(p.ciphertext, p.iv, p.wrappedDek, p.dekIv)));
		},
		async encryptWithVek(plaintext) {
			return (await getWasm()).encrypt_with_vek(plaintext);
		},
		async decryptWithVek(iv, ciphertext) {
			return (await getWasm()).decrypt_with_vek(iv, ciphertext);
		},
		async mailboxId(groupKeyB64) {
			return (await getWasm()).mailbox_id(groupKeyB64);
		},
		async mailboxSeal(groupKeyB64, aad, plaintext) {
			return (await getWasm()).mailbox_seal(groupKeyB64, aad, plaintext);
		},
		async mailboxOpen(groupKeyB64, aad, sealedB64) {
			return (await getWasm()).mailbox_open(groupKeyB64, aad, sealedB64);
		},

		async passkeyMakeCredential(rpId, userVerified) {
			return (await getWasm()).passkey_make_credential(rpId, userVerified);
		},
		async passkeyImportPkcs8(pkcs8B64) {
			return (await getWasm()).passkey_import_pkcs8(pkcs8B64);
		},
		async passkeyGetAssertion(rpId, privateKeyB64, alg, clientDataHashB64, userVerified) {
			return (await getWasm()).passkey_get_assertion(
				rpId,
				privateKeyB64,
				alg,
				clientDataHashB64,
				userVerified,
			);
		},

		async openKdbx(i) {
			const wasm = await getWasm();
			const opened = await wasm.open_kdbx4(i.file, i.password, i.keyfile);
			return {
				entries: opened.entries,
				// Bytes from WASM become a Blob, which every webview's sealer takes; a native core
				// already wrote each to a file, which the native sealer reads from where it is.
				attachments: opened.attachments.map((a) =>
					a instanceof Uint8Array
						? { source: { kind: "blob" as const, blob: new Blob([a as BlobPart]) }, size: a.length }
						: { source: { kind: "path" as const, path: a.path, size: a.size }, size: a.size },
				),
				release: opened.release ?? (async () => {}),
			};
		},

		// Both are absent on a binding layer that hasn't been regenerated with the portable
		// vault calls yet (the mobile native module). Throwing a named error beats a
		// TypeError on undefined, and the UI gates on the capability before getting here.
		async sealPortableVault(i) {
			const wasm = await getWasm();
			if (!wasm.seal_portable_vault) throw new Error("Exporting a .bramble isn't available here.");
			return wasm.seal_portable_vault(i.entriesJson, i.password, i.magicVersion);
		},

		async openPortableVault(i) {
			const wasm = await getWasm();
			if (!wasm.open_portable_vault) throw new Error("Opening a .bramble isn't available here.");
			// undefined (not a throw) is the wrong-password answer, so the caller can tell
			// a bad password from a corrupt file.
			return (await wasm.open_portable_vault(i.password, i.file, i.magicVersion)) ?? null;
		},
	};
}
