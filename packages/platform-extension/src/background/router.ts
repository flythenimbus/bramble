/// <reference types="chrome" />

// A typed handler registry with a single onMessage dispatcher. Each concern
// module registers its own handlers; the dispatcher awaits hydration once and
// wraps thrown errors, so handler bodies stay free of that boilerplate.

export type MessageEnvelope = { ok: boolean; data?: unknown; error?: string };
export type MessageHandler = (
	message: any,
	sender: chrome.runtime.MessageSender,
) => Promise<MessageEnvelope>;

const messageHandlers = new Map<string, MessageHandler>();
const prefixHandlers: Array<readonly [string, MessageHandler]> = [];

// Gates every dispatch on hydration (session VEK + known hostnames) loading once.
let ready: Promise<unknown> = Promise.resolve();

/** Register a handler for an exact message `type`. */
export function on(type: string, handler: MessageHandler): void {
	messageHandlers.set(type, handler);
}

/** Register a handler for every message `type` sharing a prefix (e.g. "CRYPTO_"). */
export function onPrefix(prefix: string, handler: MessageHandler): void {
	prefixHandlers.push([prefix, handler]);
}

/** Set the promise the dispatcher awaits before running any handler. */
export function setReady(promise: Promise<unknown>): void {
	ready = promise;
}

function resolveHandler(type: string | undefined): MessageHandler | undefined {
	if (type === undefined) return undefined;
	const exact = messageHandlers.get(type);
	if (exact) return exact;
	for (const [prefix, handler] of prefixHandlers) {
		if (type.startsWith(prefix)) return handler;
	}
	return undefined;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message?.target === "offscreen") return false;
	const handler = resolveHandler(message?.type as string | undefined);
	if (!handler) return false;
	void (async () => {
		await ready;
		try {
			sendResponse(await handler(message, sender));
		} catch (err) {
			sendResponse({ ok: false, error: String(err) });
		}
	})();
	return true;
});
