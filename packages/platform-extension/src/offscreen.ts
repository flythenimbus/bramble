/// <reference types="chrome" />
import { loadWasm, type VaultCrypto } from "./wasm-loader";

let wasm: VaultCrypto | null = null;
let inMemoryIndex: { id: string; site: string; username: string }[] = [];

async function getWasm(): Promise<VaultCrypto> {
  if (!wasm) wasm = await loadWasm();
  return wasm;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    try {
      const w = await getWasm();
      // TODO: switch on message.type — unlock / lock / encrypt / decrypt /
      // findMatches / fillFor / changePassword. Master key never leaves `w`.
      sendResponse({ ok: false, error: "TODO: handle " + (message?.type ?? "?"), _: { w, inMemoryIndex } });
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
  })();
  return true;
});
