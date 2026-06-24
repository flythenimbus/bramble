import { Capacitor } from "@capacitor/core";
import { buildCryptoAdapter } from "@core/index";
import { loadNativeCrypto } from "../native-crypto";
import { loadWasm } from "../wasm-loader";
import { markLocked, markUnlocked, onExternalChange, onExternalLock } from "./vault-session";

// The method->crypto mapping lives in @core (shared with the extension offscreen).
// On device (iOS + Android) we bind it to the native uniffi plugin (the shared Rust
// core): the autofill provider links the same core, and on iOS native crypto needs no
// JIT so the vault works under Lockdown Mode where WASM fails. A dev browser has no
// native plugin, so it falls back to the in-webview WASM module.
const loadCrypto = Capacitor.isNativePlatform() ? loadNativeCrypto : loadWasm;

export const mobileCrypto = buildCryptoAdapter(loadCrypto, {
	onUnlocked: markUnlocked,
	onLocked: markLocked,
	onExternalLock,
	onExternalChange,
});
