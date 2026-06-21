// The VaultCrypto surface is declared once in @core/wasm; this loader only owns the
// mobile-specific instantiation (loading the wasm-pack `--target web` module from
// the public dir Capacitor serves at the app root).
import type { VaultCrypto } from "@core/wasm";

export type { VaultCrypto };

let cached: Promise<VaultCrypto> | null = null;

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
