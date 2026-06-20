/** JS-facing surface of the Rust WASM crypto module (mirrors the extension's wasm-loader). */
export interface PasswordSlotBlob {
	verifier: string;
	wrapIv: string;
	wrappedVek: string;
}

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

	encrypt_entry(plaintextJson: string): {
		ciphertext: string;
		iv: string;
		wrappedDek: string;
		dekIv: string;
	};
	decrypt_entry(ciphertext: string, iv: string, wrappedDek: string, dekIv: string): string;
	encrypt_with_vek(plaintext: string): { iv: string; ciphertext: string };
	decrypt_with_vek(iv: string, ciphertext: string): string;

	open_kdbx4(
		file: Uint8Array,
		password: string,
		keyfile?: Uint8Array,
	): { strings: { key: string; value: string; protected: boolean }[] }[];
}

let cached: Promise<VaultCrypto> | null = null;

/**
 * Lazily imports and instantiates the wasm-pack (`--target web`) module from the
 * public dir, which Capacitor serves at the app root. No offscreen document and
 * no chrome.runtime needed: a mobile webview has a DOM and runs WASM in-process.
 */
export function loadWasm(): Promise<VaultCrypto> {
	if (cached) return cached;
	cached = (async () => {
		const base = import.meta.env.BASE_URL;
		const mod = await import(/* @vite-ignore */ `${base}wasm/vault_crypto.js`);
		await mod.default(`${base}wasm/vault_crypto_bg.wasm`);
		return mod as unknown as VaultCrypto;
	})();
	return cached;
}
