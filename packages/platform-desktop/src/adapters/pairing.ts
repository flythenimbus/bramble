// Pairing with a browser extension. Every call is a thin hop to the Rust side, which owns the
// static keypair (in the OS credential store), the allowlist, and the code's lifecycle. None
// of that is reachable from the webview on purpose: the code is a bearer secret and the
// private key must never enter a renderer. See src-tauri/src/pairing.rs.

import type { PairedBrowser, PairingAdapter } from "@core/adapters/pairing";
import { invoke } from "@tauri-apps/api/core";

export const desktopPairing: PairingAdapter = {
	begin: () => invoke<string>("pairing_begin"),
	cancel: () => invoke<void>("pairing_cancel"),
	isOpen: () => invoke<boolean>("pairing_is_open"),
	list: () => invoke<PairedBrowser[]>("pairing_list"),
	identity: () => invoke<string>("pairing_public_key"),
	forget: (publicKey) => invoke<boolean>("pairing_forget", { publicKey }),
};
