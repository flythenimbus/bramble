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

	// The invite a paired browser can claim over the link. Held in the shell rather than here so
	// the window closing cannot leave one claimable, and so the answer is gated where the
	// request is served. See src-tauri/src/socket.rs.
	armSyncInvite: (payload, ttlMs) => invoke<void>("link_arm_sync_invite", { payload, ttlMs }),
	clearSyncInvite: () => invoke<void>("link_clear_sync_invite"),
};
