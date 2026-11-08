// Linking with a browser extension. Every call is a thin hop to the Rust side, which owns the
// static keypair (in the OS credential store), the per-vault allowlist and the link window. None
// of that is reachable from the webview on purpose: the private key must never enter a renderer.
// See src-tauri/src/pairing.rs.

import type { PairedBrowser, PairingAdapter } from "@core/adapters/pairing";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { syncingLinkKeys } from "../sync/roster";

export const desktopPairing: PairingAdapter = {
	list: () => invoke<PairedBrowser[]>("pairing_list"),
	syncing: syncingLinkKeys,
	identity: () => invoke<string>("pairing_public_key"),
	forget: (publicKey) => invoke<boolean>("pairing_forget", { publicKey }),

	// The invite a paired browser can claim over the link. Held in the shell rather than here so
	// the window closing cannot leave one claimable, and so the answer is gated where the
	// request is served. See src-tauri/src/socket.rs.
	armSyncInvite: (payload, ttlMs) => invoke<void>("link_arm_sync_invite", { payload, ttlMs }),
	clearSyncInvite: () => invoke<void>("link_clear_sync_invite"),

	// The emoji link: the dialog opens a window, Rust holds the link until both screens answer.
	beginLinkWindow: () => invoke<void>("link_window_begin"),
	setVaultSummary: (summary) => invoke<void>("link_set_vault_summary", { summary }),
	cancelLinkWindow: () => invoke<void>("link_window_cancel"),
	answerLink: (approved) => invoke<void>("link_pair_answer", { approved }),
	onLinkPending: (cb) => subscribe<{ sasHashB64: string; label: string }>("link-pair-pending", cb),
	onLinkDone: (cb) => subscribe<{ paired: boolean }>("link-pair-done", (e) => cb(e.paired)),
};

/** A Tauri event as a synchronous unsubscribe, which is what React effects want. */
function subscribe<T>(event: string, cb: (payload: T) => void): () => void {
	let un: (() => void) | null = null;
	let gone = false;
	void listen<T>(event, (e) => cb(e.payload)).then((fn) => {
		if (gone) fn();
		else un = fn;
	});
	return () => {
		gone = true;
		un?.();
	};
}
