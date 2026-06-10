/// <reference types="chrome" />

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
	if (!chrome.runtime?.id) {
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
		chrome.runtime.sendMessage(message);
	} catch {
		extensionAlive = false;
		runTeardown();
	}
}
