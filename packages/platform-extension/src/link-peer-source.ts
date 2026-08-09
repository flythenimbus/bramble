// The desktop app on this machine, offered to sync as a peer over the native-messaging link
// instead of the relay.
//
// The mirror of the desktop's own link peer source, with one peer rather than a set: there is at
// most one desktop app per machine. Frames travel background <-> offscreen because the port lives
// in the background and sync runs here, which is the only structural difference.
//
// Being on the same machine is not an authorization. This peer proves roster membership and
// completes Noise KK keyed by its device identity like any other, so an app holding a stale
// pairing gets no further than one that dialled in over the internet.

import { makeChannel } from "@core/sync/transport/channel";
import type { PeerSession } from "@core/sync/transport/mesh";
import type { PeerSource } from "@core/sync/transport/peer-session";

/**
 * How long the desktop app stays declined after sync refuses it.
 *
 * Refusal is right at the time and wrong forever: an app enrolling a minute later would never be
 * offered again, so sync would appear to work only after restarting the browser. It re-broadcasts
 * every few seconds, so a bounded cool-down turns that into a retry.
 */
const REOFFER_AFTER_MS = 30_000;

/** A label, not a credential. roster-sync learns the peer's real identity over the channel. */
const PEER_LABEL = "desktop";

export interface LinkTransport {
	/** Hand a frame to the app. False when the link is down, which is ordinary: the app may not
	 * be running, and sync carries on over the relay. */
	send: (frame: string) => Promise<boolean>;
	/** Register the sink for frames the app sends. Returns an unsubscribe. */
	subscribe: (onFrame: (frame: string) => void) => () => void;
}

export function makeLinkPeerSource(transport: LinkTransport): PeerSource {
	return async ({ onPeer, report }) => {
		let deliver: ((frame: string) => void) | null = null;
		let declinedUntil = 0;
		let stopped = false;

		const offer = () => {
			if (stopped || deliver) return;
			if (Date.now() < declinedUntil) return;

			const { channel, push } = makeChannel((frame) => {
				// A send to an app that is not running is ordinary. Forget the peer so its next
				// broadcast offers a fresh one, rather than talking into a closed pipe.
				void transport.send(frame).then((ok) => {
					if (!ok) deliver = null;
				});
			});
			deliver = push;
			report("desktop app offered as a sync peer");
			onPeer({
				remotePubkey: PEER_LABEL,
				// The extension dials the app, so this side opened the pipe. Nothing reads it.
				initiator: true,
				channel,
				// Forgets the app as a SYNC peer without closing the link, which also carries
				// autofill delegation. Losing sync must not cost the user fill.
				close: () => {
					deliver = null;
					declinedUntil = Date.now() + REOFFER_AFTER_MS;
				},
			} satisfies PeerSession);
		};

		const unsubscribe = transport.subscribe((frame) => {
			if (!deliver) {
				// The app is talking and we have no peer for it: either sync just started, or a
				// cool-down has elapsed. Its own broadcast is the retry, so nothing has to poll.
				offer();
			}
			deliver?.(frame);
		});

		// Nothing is offered until the app speaks, which is deliberate and not just lazy.
		//
		// This end cannot tell whether a desktop app exists: most browsers have none paired, and a
		// paired one may not be running. Offering a peer regardless meant roster-auth talking into
		// a pipe that was never opened and timing out 15 seconds later, which showed up in the log
		// as a handshake failure on every start — indistinguishable from a real fault.
		//
		// The other end has the information: it learns of a browser from the socket connecting, so
		// it can always speak first, and it re-broadcasts every few seconds. So waiting costs at
		// most one tick and removes the guesswork.

		return {
			stop() {
				stopped = true;
				deliver = null;
				unsubscribe();
			},
		};
	};
}
