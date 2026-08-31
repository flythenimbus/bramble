/// <reference types="chrome" />

// Chrome delivery for the passkey provider: chrome.webAuthenticationProxy. Registers the
// create/get/isUvpaa listeners, attaches the proxy on opt-in, and recovers the calling
// origin from the active tab (the proxy events carry no origin/tab). The transport-free
// deps it drives (ceremony, vault IO, crypto, enabled flag) live in ./webauthn-provider,
// shared with the Firefox content-script transport. See docs/passkey-provider.md.

import { api } from "../platform-api";
import { on, whenReady } from "./router";
import { isProviderEnabled, productionDeps, setProviderApplyHook } from "./webauthn-provider";
import { handleCreate, handleGet } from "./webauthn-proxy";

// The proxy events carry no origin/tab, but WebAuthn requires a focused top-level
// document, so the active tab in the last-focused window is the requester. This is the
// authoritative origin for clientData + the rpId check. Null on chrome:// / unreadable tabs.
async function activeTabOrigin(): Promise<string | null> {
	try {
		const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
		if (!tab?.url) return null;
		const u = new URL(tab.url);
		return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
	} catch {
		return null;
	}
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
const inFlight = new Map<number, "create" | "get">();

async function failInFlightRequests(): Promise<void> {
	if (typeof api.webAuthenticationProxy === "undefined" || inFlight.size === 0) return;
	const pending = [...inFlight];
	inFlight.clear();
	for (const [requestId, kind] of pending) {
		const details = {
			requestId,
			error: {
				name: "NotAllowedError",
				message: "Bramble paused passkey handling to unlock its own vault. Try again.",
			},
		};
		const done =
			kind === "create"
				? api.webAuthenticationProxy.completeCreateRequest(details)
				: api.webAuthenticationProxy.completeGetRequest(details);
		await done.catch(() => {});
	}
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
	api.webAuthenticationProxy.onCreateRequest.addListener((req) => {
		inFlight.set(req.requestId, "create");
		void (async () => {
			// These listeners bypass the message router, so await hydration ourselves: on a
			// fresh SW wake the session VEK is restored asynchronously, and reading lock state
			// before it lands would wrongly prompt to unlock an already-unlocked vault.
			await whenReady();
			const origin = await activeTabOrigin();
			const details = origin
				? await handleCreate(productionDeps, req.requestId, req.requestDetailsJson, origin)
				: {
						requestId: req.requestId,
						error: { name: "NotAllowedError", message: "no resolvable tab origin" },
					};
			// Gone means a pause already failed it; completing again throws "Invalid sender".
			if (!inFlight.delete(req.requestId)) return;
			try {
				await api.webAuthenticationProxy.completeCreateRequest(details);
			} catch (e) {
				// A malformed responseJson rejects here; error the request so the page's
				// create() fails fast instead of hanging forever ("nothing happens").
				console.error("[passkey] completeCreateRequest failed", e);
				await api.webAuthenticationProxy
					.completeCreateRequest({
						requestId: req.requestId,
						error: { name: "UnknownError", message: String(e).slice(0, 200) },
					})
					.catch(() => {});
			}
		})();
	});
	api.webAuthenticationProxy.onGetRequest.addListener((req) => {
		inFlight.set(req.requestId, "get");
		void (async () => {
			await whenReady(); // as in onCreateRequest: don't read lock state before hydration
			const origin = await activeTabOrigin();
			const details = origin
				? await handleGet(productionDeps, req.requestId, req.requestDetailsJson, origin)
				: {
						requestId: req.requestId,
						error: { name: "NotAllowedError", message: "no resolvable tab origin" },
					};
			if (!inFlight.delete(req.requestId)) return; // as in onCreateRequest
			try {
				await api.webAuthenticationProxy.completeGetRequest(details);
			} catch (e) {
				console.error("[passkey] completeGetRequest failed", e);
				await api.webAuthenticationProxy
					.completeGetRequest({
						requestId: req.requestId,
						error: { name: "UnknownError", message: String(e).slice(0, 200) },
					})
					.catch(() => {});
			}
		})();
	});
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
