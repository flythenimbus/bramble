// The JS-facing surface of the Rust WASM crypto module (vault crypto only; the
// sync handshake/nostr exports live in the sync transport's *Wasm interfaces).
// Declared once here so each platform's wasm-loader imports it rather than keeping
// its own copy in sync with the Rust source. Result shapes reuse the adapter types
// so there's a single definition of each.

import type { EncryptedPayload, PasswordSlotBlob, VekEncrypted } from "./adapters/crypto";

export interface VaultCrypto {
	is_locked(): boolean;
	lock(): void;

	generate_vek(): string;
	unlock_with_vek(vekB64: string): void;
	export_vek(): string;
	rotate_vek(): string;

	generate_salt(): string;
	generate_slot_id(): string;

	wrap_vek_password(
		password: string,
		saltB64: string,
		slotIdB64: string,
		magicVersion: Uint8Array,
	): PasswordSlotBlob;
	unwrap_vek_password(
		password: string,
		saltB64: string,
		slotIdB64: string,
		verifierB64: string,
		wrapIvB64: string,
		wrappedVekB64: string,
		magicVersion: Uint8Array,
	): boolean;
	verify_password_slot(
		password: string,
		saltB64: string,
		slotIdB64: string,
		verifierB64: string,
		magicVersion: Uint8Array,
	): boolean;

	wrap_vek_webauthn(
		hmacSecretB64: string,
		slotIdB64: string,
		magicVersion: Uint8Array,
	): PasswordSlotBlob;
	unwrap_vek_webauthn(
		hmacSecretB64: string,
		slotIdB64: string,
		verifierB64: string,
		wrapIvB64: string,
		wrappedVekB64: string,
		magicVersion: Uint8Array,
	): boolean;
	verify_webauthn_slot(
		hmacSecretB64: string,
		slotIdB64: string,
		verifierB64: string,
		magicVersion: Uint8Array,
	): boolean;

	encrypt_entry(plaintextJson: string): EncryptedPayload;
	decrypt_entry(ciphertext: string, iv: string, wrappedDek: string, dekIv: string): string;
	encrypt_with_vek(plaintext: string): VekEncrypted;
	decrypt_with_vek(iv: string, ciphertext: string): string;

	open_kdbx4(
		file: Uint8Array,
		password: string,
		keyfile?: Uint8Array,
	): { strings: { key: string; value: string; protected: boolean }[] }[];
}
