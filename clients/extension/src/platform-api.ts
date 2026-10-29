/// <reference types="chrome" />

// Cross-browser WebExtension API handle. Firefox exposes the promise-based API as
// `browser`; Chrome exposes `chrome`. Use `globalThis.browser ?? chrome` (never a bare
// `browser`) so vitest under Node does not ReferenceError. Typed as `typeof chrome`:
// the codebase is promise-native and the surfaces used match Chrome's signatures.
const g = globalThis as typeof globalThis & {
	browser?: typeof chrome;
	chrome?: typeof chrome;
};
export const api: typeof chrome = (g.browser ?? g.chrome) as typeof chrome;

/** Why a port closed, read in its onDisconnect. Chrome reports it in `runtime.lastError`, Firefox
 * on the port's own `error`, which is how Firefox names a missing or refusing native host. */
export function disconnectReason(port: chrome.runtime.Port): string {
	const own = (port as { error?: { message?: string } }).error?.message;
	return own ?? api.runtime.lastError?.message ?? "disconnected";
}
