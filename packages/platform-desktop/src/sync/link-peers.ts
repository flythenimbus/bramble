// Browsers on this machine, offered to sync as peers over the native-messaging link instead of
// the relay.
//
// The app and a browser extension on one machine already have an authenticated pipe between
// them, so routing their sync traffic out to a relay and back through WebRTC is a trip through
// the internet to reach the next process along. This is the local alternative: the Rust side
// relays frames to and from each connected browser, and everything above it (roster-auth, the
// Noise KK handshake, the envelope exchange) is unchanged. See @core/sync/transport/peer-session.
//
// Being on the same machine is not an authorization. A peer offered here still has to prove it
// is in the CURRENT roster and still has to complete Noise KK keyed by its device identity, so
// an unpaired browser gets nowhere and a revoked one is dropped mid-session.

import { makeChannel } from "@core/sync/transport/channel";
import type { PeerSession } from "@core/sync/transport/mesh";
import type { PeerSource } from "@core/sync/transport/peer-session";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface PeerEvent {
	peerId: string;
	/** Which connection to that browser this is about. See the `link` generation in socket.rs. */
	link: number;
}

interface FrameEvent extends PeerEvent {
	frame: string;
}

/**
 * How long a browser sync declined to talk to stays declined.
 *
 * A peer is closed when it fails roster-auth, which is right the first time and wrong forever:
 * the same browser enrolling a minute later would never be offered again, and sync would appear
 * to work only after restarting the browser. Peers re-broadcast every few seconds, so a bounded
 * cool-down turns that into a retry without letting a genuinely unwelcome browser re-handshake
 * on every frame it sends.
 */
const REOFFER_AFTER_MS = 30_000;

interface Live {
	/** The connection this peer belongs to, so a stale event cannot tear down a newer one. */
	link: number;
	deliver: (frame: string) => void;
}

export const linkPeerSource: PeerSource = async ({ onPeer, report }) => {
	/** Live peers, by the browser's Noise static key. */
	const live = new Map<string, Live>();
	/** When each DECLINED browser becomes eligible to be offered again. */
	const cooldown = new Map<string, number>();
	let stopped = false;

	/**
	 * The browser is gone: drop it with no cool-down, so its next connection or frame is offered
	 * at once. Distinct from `decline` on purpose. A transport failure says nothing about whether
	 * this browser is welcome, and making it wait would delay a reconnect for no reason.
	 */
	const forget = (peerId: string, link?: number) => {
		if (link !== undefined && live.get(peerId)?.link !== link) return; // a newer connection owns it
		live.delete(peerId);
	};

	/**
	 * Sync refused this browser: not in the roster, revoked, or gone quiet. Hold it off for a
	 * while rather than re-handshaking on every frame it sends.
	 */
	const decline = (peerId: string, link: number) => {
		if (live.get(peerId)?.link !== link) return;
		live.delete(peerId);
		cooldown.set(peerId, Date.now() + REOFFER_AFTER_MS);
	};

	const offer = (peerId: string, link: number) => {
		if (stopped) return;
		const existing = live.get(peerId);
		// A duplicate event for the connection we already serve. Offering again would mean two
		// roster-auth handshakes racing on one pipe, each reading the other's frames.
		if (existing && existing.link >= link) return;
		const until = cooldown.get(peerId);
		if (until !== undefined && Date.now() < until) return;
		cooldown.delete(peerId);

		const { channel, push } = makeChannel((frame) => {
			// A send to a browser that has gone away is ordinary, not an error worth surfacing:
			// forget it and let its next connection be offered again immediately.
			void invoke("link_sync_send", { peerId, frame }).catch(() => forget(peerId, link));
		});
		live.set(peerId, { link, deliver: push });
		onPeer({
			remotePubkey: peerId,
			// We are the listener; browsers connect to us. Nothing reads this, but false is
			// what is true.
			initiator: false,
			channel,
			// Forgets this browser as a SYNC peer without touching the link itself. The same
			// connection serves autofill, and dropping a sync peer must not cost the user fill.
			close: () => decline(peerId, link),
		} satisfies PeerSession);
	};

	const unlisteners: UnlistenFn[] = [
		await listen<PeerEvent>("link-peer-connected", (e) => {
			const { peerId, link } = e.payload;
			// A reconnect is a fresh start for a browser we declined earlier: it should not have to
			// wait out a cool-down meant for one that is still connected and re-broadcasting.
			cooldown.delete(peerId);
			report(`browser ${peerId.slice(0, 8)} connected`);
			offer(peerId, link);
		}),
		await listen<PeerEvent>("link-peer-disconnected", (e) => {
			forget(e.payload.peerId, e.payload.link);
		}),
		await listen<FrameEvent>("link-sync-frame", (e) => {
			const { peerId, link, frame } = e.payload;
			const current = live.get(peerId);
			if (current?.link === link) {
				current.deliver(frame);
				return;
			}
			// A frame from a browser we are not serving: it connected before this source did, or a
			// cool-down has since elapsed. Offering here is what makes a peer's own re-broadcast the
			// retry, so nothing has to poll.
			offer(peerId, link);
			live.get(peerId)?.deliver(frame);
		}),
	];

	// Browsers already connected when this started. Without this they would not be offered until
	// their browser restarted, because the connect event fired before anyone was listening. The
	// registry reports the real generation, so a browser picked up here and the events about that
	// same connection are recognisably one peer rather than two.
	for (const peer of await invoke<PeerEvent[]>("link_sync_peers")) offer(peer.peerId, peer.link);

	return {
		stop() {
			stopped = true;
			live.clear();
			cooldown.clear();
			for (const un of unlisteners) un();
		},
	};
};
