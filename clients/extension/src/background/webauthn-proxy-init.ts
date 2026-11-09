/// <reference types="chrome" />

// Chrome delivery for the passkey provider: chrome.webAuthenticationProxy. Registers the
// create/get/isUvpaa listeners, attaches the proxy on opt-in, and binds each request to the page
// that made it. The transport-free deps it drives (ceremony, vault IO, crypto, enabled flag) live
// in ./webauthn-provider, shared with the Firefox content-script transport. See
// docs/passkey-provider.md.

import { api } from "../platform-api";
import { on, whenReady } from "./router";
import { proxyCaller, type RequestCaller } from "./webauthn-json";
import { depsForTab, isProviderEnabled, setProviderApplyHook } from "./webauthn-provider";
import { handleCreate, handleGet, NOT_ALLOWED } from "./webauthn-proxy";

/** The tab the user is looking at: where the card shows, and its origin when readable. */
async function focusedTab(): Promise<{ id: number; origin: string | null } | null> {
	try {
		const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
		if (tab?.id === undefined) return null;
		let origin: string | null = null;
		try {
			origin = tab.url ? new URL(tab.url).origin : null;
		} catch {}
		return { id: tab.id, origin };
	} catch {
		return null;
	}
}

/**
 * The requester (Chrome's stamp) and the tab its card goes to, or null to refuse. WebAuthn needs a
 * focused page but Chrome skips that check on the proxy path, so a top-level request must come
 * from the focused tab: otherwise a background tab on a sibling subdomain could borrow this tab's
 * approval. A cross-origin iframe can't be matched to a tab; its card names it instead.
 */
async function bindRequest(json: string): Promise<{ caller: RequestCaller; tabId: number } | null> {
	const caller = proxyCaller(json);
	const tab = await focusedTab();
	if (!caller || !tab) return null;
	if (!caller.crossOrigin && caller.origin !== tab.origin) return null;
	return { caller, tabId: tab.id };
}

// Pause the proxy while Bramble runs its OWN WebAuthn (security-key PRF) ceremony, so
// attach()'s browser-wide interception doesn't hijack our unlock. The popup/options send
// PAUSE before navigator.credentials and RESUME after (see webauthn-ceremony pauser).
// Depth-counted, but nothing nests today: createPrfCredential's create() and its fallback
// get() are SEQUENTIAL, each with its own pause cycle (webauthn-ceremony.ts), so the depth
// never exceeds 1. Firefox never fires this (security keys disabled there,
// and the override doesn't touch the extension's own moz-extension origin). See
// docs/passkey-provider.md.
let pauseDepth = 0;
let pausedWhileAttached = false;

// Requests Chrome has handed us and we have not answered yet. Detaching kills them: measured,
// the page gets a bare `AbortError` and onRequestCanceled never fires, so we would not otherwise
// know. Answering first gives the site a reason, and clearing the map stops the ceremony from
// walking the user through a picker for a request that no longer exists.
type Kind = "create" | "get";
const inFlight = new Map<number, Kind>();

// Create and get answers share one shape.
function complete(
	kind: Kind,
	details: chrome.webAuthenticationProxy.CreateResponseDetails,
): Promise<void> {
	return kind === "create"
		? api.webAuthenticationProxy.completeCreateRequest(details)
		: api.webAuthenticationProxy.completeGetRequest(details);
}

async function failInFlightRequests(): Promise<void> {
	if (typeof api.webAuthenticationProxy === "undefined" || inFlight.size === 0) return;
	const pending = [...inFlight];
	inFlight.clear();
	for (const [requestId, kind] of pending) {
		const error = {
			name: "NotAllowedError",
			message: "Bramble paused passkey handling to unlock its own vault. Try again.",
		};
		await complete(kind, { requestId, error }).catch(() => {});
	}
}

const HANDLERS = { create: handleCreate, get: handleGet } as const;

// Answer one proxied request: bind it to its page, run the ceremony, complete it once.
function serve(kind: Kind, req: { requestId: number; requestDetailsJson: string }): void {
	inFlight.set(req.requestId, kind);
	void (async () => {
		// These listeners bypass the message router, so await hydration ourselves: on a
		// fresh SW wake the session VEK is restored asynchronously, and reading lock state
		// before it lands would wrongly prompt to unlock an already-unlocked vault.
		await whenReady();
		const bound = await bindRequest(req.requestDetailsJson);
		const details = bound
			? await HANDLERS[kind](
					depsForTab(bound.tabId, () => !inFlight.has(req.requestId)),
					req.requestId,
					req.requestDetailsJson,
					bound.caller,
				)
			: { requestId: req.requestId, error: NOT_ALLOWED };
		// Gone means a pause already failed it; completing again throws "Invalid sender".
		if (!inFlight.delete(req.requestId)) return;
		try {
			await complete(kind, details);
		} catch (e) {
			// A malformed responseJson rejects here; error the request so the page's call fails
			// fast instead of hanging forever ("nothing happens").
			console.error(`[passkey] completing a ${kind} request failed`, e);
			await complete(kind, { requestId: req.requestId, error: NOT_ALLOWED }).catch(() => {});
		}
	})();
}

on("PASSKEY_PROXY_PAUSE", async () => {
	if (pauseDepth === 0 && attached) {
		pausedWhileAttached = true;
		await failInFlightRequests();
		await detachWebauthnProxy();
	}
	pauseDepth++;
	return { ok: true, data: null };
});

on("PASSKEY_PROXY_RESUME", async () => {
	if (pauseDepth > 0) pauseDepth--;
	if (pauseDepth === 0 && pausedWhileAttached) {
		pausedWhileAttached = false;
		// Re-check the pref: the user can toggle the provider off mid-ceremony, and the toggle's
		// own detach is a no-op while we are already paused-detached.
		if (isProviderEnabled()) await initWebauthnProxy();
	}
	return { ok: true, data: null };
});

let listenersRegistered = false;
let attached = false;

// Register the create/get/isUvpaa listeners exactly once. detach() does not remove
// them (it only stops events firing), so re-attach must NOT re-add them.
function registerListeners(): void {
	// Firefox has no chrome.webAuthenticationProxy; addListener on an undefined
	// namespace would throw. The Settings toggle is hidden there (shell
	// supportsPasskeyProvider), but guard here too in case the pref is set directly.
	if (listenersRegistered || typeof api.webAuthenticationProxy === "undefined") return;
	listenersRegistered = true;
	api.webAuthenticationProxy.onIsUvpaaRequest.addListener((req) => {
		api.webAuthenticationProxy.completeIsUvpaaRequest({
			requestId: req.requestId,
			isUvpaa: true,
		});
	});
	api.webAuthenticationProxy.onCreateRequest.addListener((req) => serve("create", req));
	api.webAuthenticationProxy.onGetRequest.addListener((req) => serve("get", req));
}

// Registered at module scope rather than from the attach path, and this is load-bearing: the
// ATTACHMENT outlives the service worker but these listeners do not, and a request that arrives
// before they exist is dropped permanently (not queued, and no fallback to the platform
// authenticator), so the page hangs until its own timeout. Reaching registration only after an
// async pref read left that window open on every worker wake. Listeners without an attach are
// inert, so registering unconditionally costs nothing. See docs/passkey-provider.md.
registerListeners();

/**
 * Attach the proxy. Gated behind a Settings pref (default off): attach() intercepts ALL browser
 * WebAuthn, including Bramble's own security-key unlock, which is why we pause around our own
 * ceremonies. Idempotent in Chrome (a redundant attach returns no error). Needs a real Chrome
 * end-to-end.
 */
export async function initWebauthnProxy(): Promise<void> {
	if (typeof api.webAuthenticationProxy === "undefined") return; // Firefox: no proxy API
	// A ceremony is mid-flight (startup racing a PAUSE, or the toggle flipped on during one):
	// attaching now would intercept our own security-key tap. Defer to the matching RESUME.
	if (pauseDepth > 0) {
		pausedWhileAttached = true;
		return;
	}
	if (attached) return;
	const err = await api.webAuthenticationProxy.attach();
	if (err) throw new Error(`webAuthenticationProxy.attach failed: ${err}`);
	attached = true;
}

async function detachWebauthnProxy(): Promise<void> {
	if (!attached) return;
	await api.webAuthenticationProxy.detach();
	attached = false;
}

// The toggle's live effect on Chrome is attach/detach; the shared flag it also sets gates
// the request path. On Firefox this hook stays the default no-op (no attach step).
setProviderApplyHook(async (enabled) => {
	if (enabled) await initWebauthnProxy();
	else await detachWebauthnProxy();
});
