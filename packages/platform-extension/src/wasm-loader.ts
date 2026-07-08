/// <reference types="chrome" />

import type { VaultCrypto } from "@core/wasm";
// The VaultCrypto surface is declared once in @core/wasm; this loader only owns the
// extension-specific instantiation (loading the bundle via chrome.runtime.getURL).
import { api } from "./platform-api";

export type { VaultCrypto };

let cached: Promise<VaultCrypto> | null = null;

/** Lazily imports and instantiates the WASM crypto module, caching the singleton. */
export function loadWasm(): Promise<VaultCrypto> {
	if (cached) return cached;
	cached = (async () => {
		const wasmModule = await import(
			/* @vite-ignore */ chrome.runtime.getURL("wasm/vault_crypto.js")
		);
		await wasmModule.default(api.runtime.getURL("wasm/vault_crypto_bg.wasm"));
		return wasmModule as VaultCrypto;
	})();
	return cached;
}
