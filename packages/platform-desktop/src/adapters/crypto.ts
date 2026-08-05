// CryptoAdapter backed by the Rust process, not WASM. Every call is a Tauri command over
// IPC; the VEK lives in the shell and never enters this webview, which is the whole reason
// the desktop app is a Rust binary. See docs/desktop-port.md.
//
// The core's structs already serialize camelCase, so the command results land in the shapes
// @core/adapters/crypto declares and need no mapping.

import type {
	CryptoAdapter,
	EncryptedPayload,
	KdbxRawEntry,
	OpenKdbxInput,
	PasskeyAssertion,
	PasskeyImportResult,
	PasskeyRegistration,
	PasswordSlotBlob,
	UnwrapPasswordSlotInput,
	UnwrapWebauthnSlotInput,
	VekEncrypted,
	VerifyPasswordSlotInput,
	VerifyWebauthnSlotInput,
	WrapPasswordSlotInput,
	WrapWebauthnSlotInput,
} from "@core/adapters/crypto";
import { invoke } from "@tauri-apps/api/core";

/**
 * `magicVersion` is a Uint8Array in the adapter contract; Tauri's IPC is JSON, and the
 * command signature takes `Vec<u8>`, so it rides as a plain number array.
 */
function bytes(v: Uint8Array): number[] {
	return Array.from(v);
}

/** Phase 0 gaps. These throw rather than silently no-op so a wired-up UI fails loudly. */
function notWired(what: string): never {
	throw new Error(`${what} is not wired on desktop yet`);
}

export const desktopCrypto: CryptoAdapter = {
	// Single-process, single active vault for now, so there is no per-vault VEK map to
	// bind to (the extension needs one because its background serves every open view).
	// See docs/multiple-vaults.md "Per-vault VEK".

	generateVek: () => invoke<string>("crypto_generate_vek"),
	unlockWithVek: (vekB64) => invoke<void>("crypto_unlock_with_vek", { vekB64 }),
	exportVek: () => invoke<string>("crypto_export_vek"),
	rotateVek: () => invoke<string>("crypto_rotate_vek"),
	lock: () => invoke<void>("crypto_lock"),
	isLocked: () => invoke<boolean>("crypto_is_locked"),

	// Nothing outside this webview locks or mutates the vault yet. The sync hub and the
	// spotlight window both will, and both will emit a Tauri event these subscribe to.
	onExternalLock: () => () => {},
	onExternalChange: () => () => {},

	generateSalt: () => invoke<string>("crypto_generate_salt"),
	generateSlotId: () => invoke<string>("crypto_generate_slot_id"),

	wrapVekPassword: (input: WrapPasswordSlotInput) =>
		invoke<PasswordSlotBlob>("crypto_wrap_vek_password", {
			password: input.password,
			saltB64: input.saltB64,
			slotIdB64: input.slotIdB64,
			magicVersion: bytes(input.magicVersion),
		}),
	unwrapVekPassword: (input: UnwrapPasswordSlotInput) =>
		invoke<boolean>("crypto_unwrap_vek_password", {
			password: input.password,
			saltB64: input.saltB64,
			slotIdB64: input.slotIdB64,
			verifierB64: input.verifierB64,
			wrapIvB64: input.wrapIvB64,
			wrappedVekB64: input.wrappedVekB64,
			magicVersion: bytes(input.magicVersion),
		}),
	verifyPasswordSlot: (input: VerifyPasswordSlotInput) =>
		invoke<boolean>("crypto_verify_password_slot", {
			password: input.password,
			saltB64: input.saltB64,
			slotIdB64: input.slotIdB64,
			verifierB64: input.verifierB64,
			magicVersion: bytes(input.magicVersion),
		}),

	// Wired because the core calls cost nothing, but `securityKeys` is off for desktop in
	// flags.ts: the webview has no usable WebAuthn, so nothing can produce an hmac-secret
	// until there is a native CTAP path.
	wrapVekWebauthn: (input: WrapWebauthnSlotInput) =>
		invoke<PasswordSlotBlob>("crypto_wrap_vek_webauthn", {
			hmacSecretB64: input.hmacSecretB64,
			slotIdB64: input.slotIdB64,
			magicVersion: bytes(input.magicVersion),
		}),
	unwrapVekWebauthn: (input: UnwrapWebauthnSlotInput) =>
		invoke<boolean>("crypto_unwrap_vek_webauthn", {
			hmacSecretB64: input.hmacSecretB64,
			slotIdB64: input.slotIdB64,
			verifierB64: input.verifierB64,
			wrapIvB64: input.wrapIvB64,
			wrappedVekB64: input.wrappedVekB64,
			magicVersion: bytes(input.magicVersion),
		}),
	verifyWebauthnSlot: (input: VerifyWebauthnSlotInput) =>
		invoke<boolean>("crypto_verify_webauthn_slot", {
			hmacSecretB64: input.hmacSecretB64,
			slotIdB64: input.slotIdB64,
			verifierB64: input.verifierB64,
			magicVersion: bytes(input.magicVersion),
		}),

	encryptEntry: (plaintextJson) =>
		invoke<EncryptedPayload>("crypto_encrypt_entry", { plaintextJson }),
	decryptEntry: (payload) => invoke<string>("crypto_decrypt_entry", { payload }),
	// One IPC round trip for the whole vault, not one per entry.
	decryptEntries: (payloads) => invoke<string[]>("crypto_decrypt_entries", { payloads }),
	encryptWithVek: (plaintext) => invoke<VekEncrypted>("crypto_encrypt_with_vek", { plaintext }),
	decryptWithVek: (iv, ciphertext) => invoke<string>("crypto_decrypt_with_vek", { iv, ciphertext }),

	// Passkey provider: the core calls exist but sit behind a private module, so exposing
	// them needs a core-rust re-export first. Desktop is not a passkey provider yet anyway.
	passkeyMakeCredential: (): Promise<PasskeyRegistration> => notWired("Passkey provider"),
	passkeyImportPkcs8: (): Promise<PasskeyImportResult> => notWired("Passkey import"),
	passkeyGetAssertion: (): Promise<PasskeyAssertion> => notWired("Passkey assertion"),

	// KDBX import: same story, `open_kdbx4` lives in a private module in core-rust.
	openKdbx: (_input: OpenKdbxInput): Promise<KdbxRawEntry[]> => notWired("KeePass import"),
};
