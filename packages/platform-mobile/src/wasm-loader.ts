// The VaultCrypto surface is declared once in @core/wasm; this loader only owns the
// mobile-specific instantiation (loading the wasm-pack `--target web` module from
// the public dir Capacitor serves at the app root).
import { Capacitor } from "@capacitor/core";
import type { VaultCrypto } from "@core/wasm";

export type { VaultCrypto };

let cached: Promise<VaultCrypto> | null = null;

export function loadWasm(): Promise<VaultCrypto> {
	// Guardrail: on iOS every crypto path (vault + sync) runs natively via the uniffi
	// plugin, so the app works under Lockdown Mode where WASM is absent. Reaching WASM
	// on iOS is a wiring bug, so fail loudly instead of dying later under Lockdown.
	// (Android has no Lockdown Mode; its sync still uses WASM until the native handshake
	// is wired there, so the guard is iOS-only.)
	if (Capacitor.getPlatform() === "ios") {
		throw new Error("WASM crypto must not load on iOS; use the native plugin");
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
