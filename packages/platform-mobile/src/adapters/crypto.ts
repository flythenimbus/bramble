import { Capacitor } from "@capacitor/core";
import { buildCryptoAdapter } from "@core/index";
import { loadNativeCrypto } from "../native-crypto";
import { loadWasm } from "../wasm-loader";
import { markLocked, markUnlocked, onExternalChange, onExternalLock } from "./vault-session";

// The method->crypto mapping lives in @core (shared with the extension offscreen).
// On iOS we bind it to the native uniffi plugin (the shared Rust core): native crypto
// needs no JIT, so the vault works under iOS Lockdown Mode where WASM fails, and the
// autofill extension links the same core. Android keeps the in-webview WASM module
// (its WebView has no JIT restriction; the native plugin there is a follow-up), and a
// dev browser falls back to WASM too.
const loadCrypto = Capacitor.getPlatform() === "ios" ? loadNativeCrypto : loadWasm;

export const mobileCrypto = buildCryptoAdapter(loadCrypto, {
	onUnlocked: markUnlocked,
	onLocked: markLocked,
	onExternalLock,
	onExternalChange,
});
