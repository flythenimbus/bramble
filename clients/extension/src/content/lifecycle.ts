/// <reference types="chrome" />
import { api } from "./content-api";

// Extension-context lifecycle. A content script is orphaned when its extension
// is reloaded/updated; the first failed access tears everything down. Modules
// register their cleanup via onTeardown.

let extensionAlive = true;
const teardownCallbacks: Array<() => void> = [];

/** Register a cleanup to run when the extension context is torn down. */
export function onTeardown(cb: () => void): void {
	teardownCallbacks.push(cb);
}

function runTeardown(): void {
	for (const cb of teardownCallbacks) cb();
}

/** False once the extension context is invalidated (orphaned content script); tears us down on first detection. */
export function isExtensionAlive(): boolean {
	if (!extensionAlive) return false;
	if (!api.runtime?.id) {
		extensionAlive = false;
		runTeardown();
		return false;
	}
	return true;
}

/** Mark the context dead and tear down (used when a messaging call throws). */
export function markExtensionDead(): void {
	extensionAlive = false;
	runTeardown();
}

/** Sends a runtime message, swallowing the throw if the extension context is gone. */
export function safeSendMessage(message: unknown): void {
	if (!isExtensionAlive()) return;
	try {
		api.runtime.sendMessage(message);
	} catch {
		extensionAlive = false;
		runTeardown();
	}
}

/**
 * Send a one-shot request and return its direct response. A synchronous context failure
 * means this content script has been orphaned; a rejected/closed response channel is a
 * normal quiet cancellation (for example, navigation while the background is awaiting).
 */
export async function safeRequest<T>(message: unknown): Promise<T | undefined> {
	if (!isExtensionAlive()) return undefined;
	let response: Promise<T>;
	try {
		response = api.runtime.sendMessage(message) as Promise<T>;
	} catch {
		markExtensionDead();
		return undefined;
	}
	try {
		return await response;
	} catch {
		return undefined;
	}
}
