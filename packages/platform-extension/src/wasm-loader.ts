/// <reference types="chrome" />

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

	encrypt_entry(plaintextJson: string): {
		ciphertext: string;
		iv: string;
		wrappedDek: string;
		dekIv: string;
	};
	decrypt_entry(ciphertext: string, iv: string, wrappedDek: string, dekIv: string): string;
	encrypt_with_vek(plaintext: string): { iv: string; ciphertext: string };
	decrypt_with_vek(iv: string, ciphertext: string): string;
}

let cached: Promise<VaultCrypto> | null = null;

export function loadWasm(): Promise<VaultCrypto> {
	if (cached) return cached;
	cached = (async () => {
		const wasmModule = await import(
			/* @vite-ignore */ chrome.runtime.getURL("wasm/vault_crypto.js")
		);
		await wasmModule.default(chrome.runtime.getURL("wasm/vault_crypto_bg.wasm"));
		return wasmModule as unknown as VaultCrypto;
	})();
	return cached;
}
