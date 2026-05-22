/// <reference types="chrome" />

export interface VaultCrypto {
	unlock(password: string, saltB64: string): void;
	lock(): void;
	is_locked(): boolean;
	encrypt_entry(plaintextJson: string): {
		ciphertext: string;
		iv: string;
		wrappedDek: string;
		dekIv: string;
	};
	decrypt_entry(ciphertext: string, iv: string, wrappedDek: string, dekIv: string): string;
	generate_salt(): string;
	verifier_for(magic: Uint8Array): Uint8Array;
	encrypt_with_master(plaintext: string): { iv: string; ciphertext: string };
	decrypt_with_master(iv: string, ciphertext: string): string;
	change_password(newPassword: string, newSaltB64: string, entries: unknown): unknown;
}

let cached: Promise<VaultCrypto> | null = null;

export function loadWasm(): Promise<VaultCrypto> {
	if (cached) return cached;
	cached = (async () => {
		// wasm-pack output goes to public/wasm/. Adjust import path to match
		// the generated package name (e.g. vault_crypto.js).
		const wasmModule = await import(
			/* @vite-ignore */ chrome.runtime.getURL("wasm/vault_crypto.js")
		);
		await wasmModule.default(chrome.runtime.getURL("wasm/vault_crypto_bg.wasm"));
		return wasmModule as unknown as VaultCrypto;
	})();
	return cached;
}
