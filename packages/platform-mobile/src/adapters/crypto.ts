import { buildCryptoAdapter } from "@core/index";
import { loadWasm } from "../wasm-loader";
import { markLocked, markUnlocked, onExternalChange, onExternalLock } from "./vault-session";

// In-webview crypto: the method->wasm mapping lives in @core (shared with the
// extension offscreen); here we bind it to the lazy wasm loader and the mobile
// vault-session lifecycle. No offscreen hop — the webview has a DOM.
export const mobileCrypto = buildCryptoAdapter(loadWasm, {
	onUnlocked: markUnlocked,
	onLocked: markLocked,
	onExternalLock,
	onExternalChange,
});
