// Thin client over a relay WebSocket: subscribe to a room, publish signed events,
// dispatch peers' events. Speaks the Nostr subset the relay (nostr-relay/node/relay.mjs)
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
	/** Replace the room subscription (epoch rollover); reuses the subId so the relay swaps it. */
	resubscribe(rooms: string | string[]): void;
	close(): void;
}

let subCounter = 0;

/**
 * Our keepalive frames. Deliberately not JSON: a relay that doesn't know them parses nothing and
 * answers nothing, and our own reader drops the reply before it reaches the event dispatch.
 */
export const RELAY_PING = "ping";
export const RELAY_PONG = "pong";

/**
 * How often to ping. Cloudflare drops an idle WebSocket after a minute or two, and our relay answers
 * these from the Durable Object's hibernation auto-response, so a held-open socket costs one frame
 * each way and never wakes the relay. Without it the sync socket was dropped and rebuilt
 * continuously; on Chrome each drop woke the suspended service worker, which restarted sync.
 */
const PING_MS = 25_000;
/**
 * Silence this long means the relay is gone even though the socket never said so — a dead NAT
 * binding, a machine that suspended. Close, so the caller's onclose reconnects. Two missed pings, so
 * one slow round trip doesn't bounce a healthy socket.
 */
const SILENCE_MS = 70_000;

/**
 * Drive a relay socket for one room. Sends the REQ on open, dispatches incoming
 * room events to `onEvent`, and publishes events (buffering any sent before the
 * socket opens). Pings the relay while open, so a socket that is merely idle isn't
 * dropped and one that is dead is noticed.
 */
export function connectSignaling(
	socket: SocketLike,
	rooms: string | string[],
	onEvent: (event: NostrEvent) => void,
	onOpen?: () => void,
): SignalingClient {
	const subId = `s${subCounter++}`;
	let open = false;
	const pending: string[] = [];
	/** When we last heard anything at all from the relay. */
	let lastHeard = 0;
	/** Whether this relay answers pings, which is what makes its silence meaningful. A stock Nostr
	 * relay ignores them, and must not be declared dead for it. */
	let pongSeen = false;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	const stopHeartbeat = () => {
		if (heartbeat !== undefined) clearInterval(heartbeat);
		heartbeat = undefined;
	};

	const sendRaw = (frame: string) => {
		if (open) socket.send(frame);
		else pending.push(frame);
	};
	const subscribe = (r: string | string[]) =>
		sendRaw(JSON.stringify(["REQ", subId, signalFilter(r)]));

	socket.onopen = () => {
		open = true;
		lastHeard = Date.now();
		onOpen?.();
		subscribe(rooms);
		for (const frame of pending) socket.send(frame);
		pending.length = 0;
		heartbeat = setInterval(() => {
			if (pongSeen && Date.now() - lastHeard > SILENCE_MS) {
				stopHeartbeat();
				socket.close(); // the caller's onclose reconnects
				return;
			}
			socket.send(RELAY_PING);
		}, PING_MS);
	};

	socket.onmessage = (ev) => {
		lastHeard = Date.now();
		if (ev.data === RELAY_PONG) {
			pongSeen = true;
			return;
		}
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

	// Stop pinging a socket that has gone away, whoever closed it. Chained rather than owned: the
	// caller sets its own onclose (the reconnect) before calling us and still needs it. The silence
	// check above remains the backstop if a caller replaces the handler afterwards.
	const callerClose = socket.onclose;
	socket.onclose = (ev) => {
		stopHeartbeat();
		callerClose?.(ev);
	};

	return {
		publish: (event) => sendRaw(JSON.stringify(["EVENT", event])),
		resubscribe: subscribe,
		close: () => {
			stopHeartbeat();
			try {
				socket.send(JSON.stringify(["CLOSE", subId]));
			} catch {}
			socket.close();
		},
	};
}
