// The VaultCrypto surface is declared once in @core/wasm; this loader only owns the
// mobile-specific instantiation (loading the wasm-pack `--target web` module from
// the public dir Capacitor serves at the app root).
import { Capacitor } from "@capacitor/core";
import type { VaultCrypto } from "@core/wasm";

export type { VaultCrypto };

let cached: Promise<VaultCrypto> | null = null;

export function loadWasm(): Promise<VaultCrypto> {
	// Guardrail: on a real device (iOS + Android) every crypto path (vault + sync) runs
	// natively via the uniffi plugin, so the app works under iOS Lockdown Mode where WASM
	// is absent, and sync shares the native module that holds the VEK. WASM is only the
	// dev-browser fallback; reaching it on a device is a wiring bug, so fail loudly.
	if (Capacitor.isNativePlatform()) {
		throw new Error("WASM crypto must not load on a native device; use the native plugin");
	}
	if (cached) return cached;
	cached = (async () => {
		const base = import.meta.env.BASE_URL;
		const mod = await import(/* @vite-ignore */ `${base}wasm/vault_crypto.js`);
		await mod.default(`${base}wasm/vault_crypto_bg.wasm`);
		return mod as unknown as VaultCrypto;
	})();
	return cached;
}
