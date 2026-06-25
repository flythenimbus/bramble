// Drives a Noise handshake to completion over a Channel and returns the live
// session id (for handshake_encrypt/decrypt) plus the peer's static public key.
// The pattern (XXpsk3 for enrollment, KK for roster-auth) only differs in the
// first step, injected as a `start` thunk; the message pump is shared.
// See docs/p2p-sync.md.

import type { Channel } from "./channel";

/** A crypto result that's synchronous on the in-webview WASM path and a Promise on
 * mobile (where the crypto crosses the native plugin bridge). Callers await it; on the
 * sync path the await is a no-op, so the same transport drives both. */
export type Awaitable<T> = T | Promise<T>;

export interface PumpWasm {
	handshake_read(
		sessionId: number,
		messageB64: string,
	): Awaitable<{ message?: string; done: boolean }>;
	handshake_remote_static(sessionId: number): Awaitable<string>;
}

export interface Session {
	sessionId: number;
	remoteStatic: string;
}

async function pump(wasm: PumpWasm, channel: Channel, sessionId: number): Promise<void> {
	for (let done = false; !done; ) {
		const reply = await wasm.handshake_read(sessionId, await channel.recv());
		if (reply.message) channel.send(reply.message);
		done = reply.done;
	}
}

/** Run the side that sends the first message (`start` returns its id + first message). */
export async function runInitiator(
	wasm: PumpWasm,
	channel: Channel,
	start: () => Awaitable<{ sessionId: number; message: string }>,
): Promise<Session> {
	const { sessionId, message } = await start();
	channel.send(message);
	await pump(wasm, channel, sessionId);
	return { sessionId, remoteStatic: await wasm.handshake_remote_static(sessionId) };
}

/** Run the side that awaits the first message (`start` returns its session id). */
export async function runResponder(
	wasm: PumpWasm,
	channel: Channel,
	start: () => Awaitable<number>,
): Promise<Session> {
	const sessionId = await start();
	await pump(wasm, channel, sessionId);
	return { sessionId, remoteStatic: await wasm.handshake_remote_static(sessionId) };
}
