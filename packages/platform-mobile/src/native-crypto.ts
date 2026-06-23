// Native crypto loader: backs the @core VaultCrypto surface with the in-house
// NativeCrypto Capacitor plugin (the shared Rust core via uniffi), instead of the
// in-webview WASM module. Used on device so the vault works under iOS Lockdown Mode
// (native code needs no JIT) and so the autofill extension shares the same crypto.
// Byte-array args (magicVersion, KDBX files) cross the bridge as base64.

import { registerPlugin } from "@capacitor/core";
import type { EncryptedPayload, PasswordSlotBlob, VekEncrypted } from "@core/adapters/crypto";
import { bytesToBase64 } from "@core/util/bytes";
import type { VaultCrypto } from "@core/wasm";

type KdbxEntry = { strings: { key: string; value: string; protected: boolean }[] };

interface NativeCryptoPlugin {
	isLocked(): Promise<{ value: boolean }>;
	lock(): Promise<void>;
	generateVek(): Promise<{ value: string }>;
	unlockWithVek(o: { vekB64: string }): Promise<void>;
	exportVek(): Promise<{ value: string }>;
	rotateVek(): Promise<{ value: string }>;
	generateSalt(): Promise<{ value: string }>;
	generateSlotId(): Promise<{ value: string }>;
	wrapVekPassword(o: {
		password: string;
		saltB64: string;
		slotIdB64: string;
		magicVersionB64: string;
	}): Promise<PasswordSlotBlob>;
	unwrapVekPassword(o: {
		password: string;
		saltB64: string;
		slotIdB64: string;
		verifierB64: string;
		wrapIvB64: string;
		wrappedVekB64: string;
		magicVersionB64: string;
	}): Promise<{ value: boolean }>;
	verifyPasswordSlot(o: {
		password: string;
		saltB64: string;
		slotIdB64: string;
		verifierB64: string;
		magicVersionB64: string;
	}): Promise<{ value: boolean }>;
	wrapVekWebauthn(o: {
		hmacSecretB64: string;
		slotIdB64: string;
		magicVersionB64: string;
	}): Promise<PasswordSlotBlob>;
	unwrapVekWebauthn(o: {
		hmacSecretB64: string;
		slotIdB64: string;
		verifierB64: string;
		wrapIvB64: string;
		wrappedVekB64: string;
		magicVersionB64: string;
	}): Promise<{ value: boolean }>;
	verifyWebauthnSlot(o: {
		hmacSecretB64: string;
		slotIdB64: string;
		verifierB64: string;
		magicVersionB64: string;
	}): Promise<{ value: boolean }>;
	encryptEntry(o: { plaintextJson: string }): Promise<EncryptedPayload>;
	decryptEntry(o: {
		ciphertext: string;
		iv: string;
		wrappedDek: string;
		dekIv: string;
	}): Promise<{ value: string }>;
	encryptWithVek(o: { plaintext: string }): Promise<VekEncrypted>;
	decryptWithVek(o: { ivB64: string; ciphertextB64: string }): Promise<{ value: string }>;
	openKdbx4(o: {
		fileB64: string;
		password: string;
		keyfileB64?: string;
	}): Promise<{ entries: KdbxEntry[] }>;
}

const Native = registerPlugin<NativeCryptoPlugin>("NativeCrypto");

// VaultCrypto methods are async here (each crosses the bridge); buildCryptoAdapter
// awaits them, so the same adapter serves this and the synchronous WASM module.
const nativeModule: VaultCrypto = {
	is_locked: async () => (await Native.isLocked()).value,
	lock: () => Native.lock(),
	generate_vek: async () => (await Native.generateVek()).value,
	unlock_with_vek: (vekB64) => Native.unlockWithVek({ vekB64 }),
	export_vek: async () => (await Native.exportVek()).value,
	rotate_vek: async () => (await Native.rotateVek()).value,
	generate_salt: async () => (await Native.generateSalt()).value,
	generate_slot_id: async () => (await Native.generateSlotId()).value,

	wrap_vek_password: (password, saltB64, slotIdB64, magicVersion) =>
		Native.wrapVekPassword({
			password,
			saltB64,
			slotIdB64,
			magicVersionB64: bytesToBase64(magicVersion),
		}),
	unwrap_vek_password: async (
		password,
		saltB64,
		slotIdB64,
		verifierB64,
		wrapIvB64,
		wrappedVekB64,
		magicVersion,
	) =>
		(
			await Native.unwrapVekPassword({
				password,
				saltB64,
				slotIdB64,
				verifierB64,
				wrapIvB64,
				wrappedVekB64,
				magicVersionB64: bytesToBase64(magicVersion),
			})
		).value,
	verify_password_slot: async (password, saltB64, slotIdB64, verifierB64, magicVersion) =>
		(
			await Native.verifyPasswordSlot({
				password,
				saltB64,
				slotIdB64,
				verifierB64,
				magicVersionB64: bytesToBase64(magicVersion),
			})
		).value,

	wrap_vek_webauthn: (hmacSecretB64, slotIdB64, magicVersion) =>
		Native.wrapVekWebauthn({
			hmacSecretB64,
			slotIdB64,
			magicVersionB64: bytesToBase64(magicVersion),
		}),
	unwrap_vek_webauthn: async (
		hmacSecretB64,
		slotIdB64,
		verifierB64,
		wrapIvB64,
		wrappedVekB64,
		magicVersion,
	) =>
		(
			await Native.unwrapVekWebauthn({
				hmacSecretB64,
				slotIdB64,
				verifierB64,
				wrapIvB64,
				wrappedVekB64,
				magicVersionB64: bytesToBase64(magicVersion),
			})
		).value,
	verify_webauthn_slot: async (hmacSecretB64, slotIdB64, verifierB64, magicVersion) =>
		(
			await Native.verifyWebauthnSlot({
				hmacSecretB64,
				slotIdB64,
				verifierB64,
				magicVersionB64: bytesToBase64(magicVersion),
			})
		).value,

	encrypt_entry: (plaintextJson) => Native.encryptEntry({ plaintextJson }),
	decrypt_entry: async (ciphertext, iv, wrappedDek, dekIv) =>
		(await Native.decryptEntry({ ciphertext, iv, wrappedDek, dekIv })).value,
	encrypt_with_vek: (plaintext) => Native.encryptWithVek({ plaintext }),
	decrypt_with_vek: async (iv, ciphertext) =>
		(await Native.decryptWithVek({ ivB64: iv, ciphertextB64: ciphertext })).value,

	open_kdbx4: async (file, password, keyfile) =>
		(
			await Native.openKdbx4({
				fileB64: bytesToBase64(file),
				password,
				keyfileB64: keyfile ? bytesToBase64(keyfile) : undefined,
			})
		).entries,
};

export function loadNativeCrypto(): Promise<VaultCrypto> {
	return Promise.resolve(nativeModule);
}
