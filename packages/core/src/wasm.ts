// The JS-facing surface of the Rust WASM crypto module (vault crypto only; the
// sync handshake/nostr exports live in the sync transport's *Wasm interfaces).
// Declared once here so each platform's wasm-loader imports it rather than keeping
// its own copy in sync with the Rust source. Result shapes reuse the adapter types
// so there's a single definition of each.

import type {
	EncryptedPayload,
	PasskeyAssertion,
	PasskeyImportResult,
	PasskeyRegistration,
	PasswordSlotBlob,
	VekEncrypted,
} from "./adapters/crypto";

// Each call returns its value either synchronously (the in-process WASM module) or
// as a promise (the native uniffi plugin, which crosses the Capacitor bridge). The
// CryptoAdapter awaits every call, so one surface serves both transports.
type Awaitable<T> = T | Promise<T>;

export interface VaultCrypto {
	is_locked(): Awaitable<boolean>;
	lock(): Awaitable<void>;

	generate_vek(): Awaitable<string>;
	unlock_with_vek(vekB64: string): Awaitable<void>;
	export_vek(): Awaitable<string>;
	rotate_vek(): Awaitable<string>;

	generate_salt(): Awaitable<string>;
	generate_slot_id(): Awaitable<string>;

	wrap_vek_password(
		password: string,
		saltB64: string,
		slotIdB64: string,
		magicVersion: Uint8Array,
	): Awaitable<PasswordSlotBlob>;
	unwrap_vek_password(
		password: string,
		saltB64: string,
		slotIdB64: string,
		verifierB64: string,
		wrapIvB64: string,
		wrappedVekB64: string,
		magicVersion: Uint8Array,
	): Awaitable<boolean>;
	verify_password_slot(
		password: string,
		saltB64: string,
		slotIdB64: string,
		verifierB64: string,
		magicVersion: Uint8Array,
	): Awaitable<boolean>;

	wrap_vek_webauthn(
		hmacSecretB64: string,
		slotIdB64: string,
		magicVersion: Uint8Array,
	): Awaitable<PasswordSlotBlob>;
	unwrap_vek_webauthn(
		hmacSecretB64: string,
		slotIdB64: string,
		verifierB64: string,
		wrapIvB64: string,
		wrappedVekB64: string,
		magicVersion: Uint8Array,
	): Awaitable<boolean>;
	verify_webauthn_slot(
		hmacSecretB64: string,
		slotIdB64: string,
		verifierB64: string,
		magicVersion: Uint8Array,
	): Awaitable<boolean>;

	encrypt_entry(plaintextJson: string): Awaitable<EncryptedPayload>;
	decrypt_entry(
		ciphertext: string,
		iv: string,
		wrappedDek: string,
		dekIv: string,
	): Awaitable<string>;
	// Optional batch decrypt: native transports (mobile) loop over the entries
	// in-process and return them all in one bridge call. Absent on the wasm module,
	// where buildCryptoAdapter falls back to a per-entry loop.
	decrypt_entries?(entries: EncryptedPayload[]): Awaitable<string[]>;
	encrypt_with_vek(plaintext: string): Awaitable<VekEncrypted>;
	decrypt_with_vek(iv: string, ciphertext: string): Awaitable<string>;

	passkey_make_credential(rpId: string, userVerified: boolean): Awaitable<PasskeyRegistration>;
	passkey_import_pkcs8(pkcs8B64: string): Awaitable<PasskeyImportResult>;
	passkey_get_assertion(
		rpId: string,
		privateKeyB64: string,
		clientDataHashB64: string,
		userVerified: boolean,
	): Awaitable<PasskeyAssertion>;

	open_kdbx4(
		file: Uint8Array,
		password: string,
		keyfile?: Uint8Array,
	): Awaitable<{ strings: { key: string; value: string; protected: boolean }[] }[]>;

	/** KDBX4 export. Optional: only the WASM module implements it, since export is an
	 * extension-only affordance (mobile has no shell.exportBytes). The mobile native
	 * module deliberately omits it rather than carrying a stub that can't work. */
	save_kdbx4?(
		entries: { strings: { key: string; value: string; protected: boolean }[] }[],
		password: string,
	): Uint8Array;
}
