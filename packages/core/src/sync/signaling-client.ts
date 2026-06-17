// Thin client over a relay WebSocket: subscribe to a room, publish signed events,
// dispatch peers' events. Speaks the Nostr subset the relay (signaling/relay.mjs)
// and public relays understand. The WebSocket is injected so this is testable
// without a live server. See docs/p2p-sync.md.

import type { NostrEvent } from "./nostr";
import { signalFilter } from "./nostr";

/** The slice of WebSocket this client uses (injectable for tests). */
export interface SocketLike {
	send(data: string): void;
	close(): void;
	onopen: ((ev?: unknown) => void) | null;
	onmessage: ((ev: { data: string }) => void) | null;
	onclose: ((ev?: unknown) => void) | null;
	onerror: ((ev?: unknown) => void) | null;
}

export interface SignalingClient {
	/** Publish a signed event to the room. Buffered until the socket is open. */
	publish(event: NostrEvent): void;
	close(): void;
}

let subCounter = 0;

/**
 * Drive a relay socket for one room. Sends the REQ on open, dispatches incoming
 * room events to `onEvent`, and publishes events (buffering any sent before the
 * socket opens).
 */
export function connectSignaling(
	socket: SocketLike,
	room: string,
	onEvent: (event: NostrEvent) => void,
): SignalingClient {
	const subId = `s${subCounter++}`;
	let open = false;
	const pending: string[] = [];

	const sendRaw = (frame: string) => {
		if (open) socket.send(frame);
		else pending.push(frame);
	};

	socket.onopen = () => {
		open = true;
		socket.send(JSON.stringify(["REQ", subId, signalFilter(room)]));
		for (const frame of pending) socket.send(frame);
		pending.length = 0;
	};

	socket.onmessage = (ev) => {
		let msg: unknown;
		try {
			msg = JSON.parse(ev.data);
		} catch {
			return;
		}
		if (!Array.isArray(msg)) return;
		// ["EVENT", subId, event] addressed to our subscription.
		if (msg[0] === "EVENT" && msg[1] === subId && msg[2]) onEvent(msg[2] as NostrEvent);
	};

	return {
		publish: (event) => sendRaw(JSON.stringify(["EVENT", event])),
		close: () => {
			try {
				socket.send(JSON.stringify(["CLOSE", subId]));
			} catch {}
			socket.close();
		},
	};
}
