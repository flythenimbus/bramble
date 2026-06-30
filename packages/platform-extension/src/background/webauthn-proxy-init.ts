/// <reference types="chrome" />

// Production wiring for the passkey provider: builds the deps the pure handlers in
// ./webauthn-proxy consume (corner-card ceremony, vault IO, crypto, sha256), registers
// the PASSKEY_PROMPT_RESPONSE resolver, and attaches the proxy. Split out so
// ./webauthn-proxy stays import-safe (no chrome at import) and unit-testable. The
// ceremony reuses the save-login corner card placement. See docs/passkey-provider.md.

import type { PasskeyPromptResponse, SavePasskeyPrompt } from "@core/adapters/autofill";
import { bytesToBase64 } from "@core/util/bytes";
import { api } from "../platform-api";
import {
	loadDecryptedEntries,
	passkeyGetAssertion,
	passkeyMakeCredential,
	savePlacement,
} from "./passkey-store";
import { on } from "./router";
import { vaultLocked } from "./session";
import {
	type CeremonyFn,
	type CeremonyHost,
	type CeremonyRequest,
	handleCreate,
	handleGet,
	type PasskeyProxyDeps,
	runCreateCeremony,
	runGetCeremony,
} from "./webauthn-proxy";

const CEREMONY_TIMEOUT_MS = 120_000;
const UNLOCK_TIMEOUT_MS = 90_000;

type PromptReply = { approved: boolean; choice?: string };
// In-flight passkey cards keyed by promptId; resolved by PASSKEY_PROMPT_RESPONSE.
const pendingPrompts = new Map<string, (reply: PromptReply) => void>();

async function activeTabId(): Promise<number | undefined> {
	try {
		const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
		return tab?.id;
	} catch {
		return undefined;
	}
}

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

async function openPopupForUnlock(): Promise<void> {
	try {
		const openPopup = (api.action as unknown as { openPopup?: () => Promise<void> }).openPopup;
		if (typeof openPopup === "function") {
			await openPopup.call(api.action);
			return;
		}
	} catch {}
	try {
		await api.windows.create({
			url: api.runtime.getURL("popup.html?detached=1"),
			type: "popup",
			focused: true,
			width: 500,
			height: 600,
		});
	} catch {}
}

async function waitForUnlock(timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!vaultLocked()) return true;
		await new Promise((r) => setTimeout(r, 400));
	}
	return !vaultLocked();
}

// Show one corner card (same placement as save-login) and await the reply; teardown or
// timeout counts as declined.
function showCard(tabId: number, payload: SavePasskeyPrompt): Promise<PromptReply> {
	return new Promise((resolve) => {
		pendingPrompts.set(payload.promptId, resolve);
		api.tabs.sendMessage(tabId, { type: "CORNER_PROMPT_SHOW", payload }).catch(() => {
			if (pendingPrompts.delete(payload.promptId)) resolve({ approved: false });
		});
		setTimeout(() => {
			if (pendingPrompts.delete(payload.promptId)) resolve({ approved: false });
		}, CEREMONY_TIMEOUT_MS);
	});
}

function cardPayload(
	req: CeremonyRequest,
	extra: Partial<SavePasskeyPrompt> = {},
): SavePasskeyPrompt {
	return {
		kind: "save-passkey",
		promptId: globalThis.crypto.randomUUID(),
		hostname: req.rpId,
		locked: vaultLocked(),
		intent: req.kind,
		rpId: req.rpId,
		rpName: req.kind === "create" ? req.rpName : undefined,
		userName: req.kind === "create" ? req.userName : undefined,
		...extra,
	};
}

async function ensureUnlocked(): Promise<boolean> {
	if (!vaultLocked()) return true;
	await openPopupForUnlock();
	return waitForUnlock(UNLOCK_TIMEOUT_MS);
}

// The ceremony decision logic lives in ./webauthn-proxy (runCreateCeremony/runGetCeremony,
// unit-tested); here we just supply the chrome-backed host: the corner card, popup unlock,
// and offscreen vault read.
const cornerCeremony: CeremonyFn = async (req) => {
	const tabId = await activeTabId();
	if (tabId === undefined) return { approved: false };
	const host: CeremonyHost = {
		isLocked: vaultLocked,
		ensureUnlocked,
		loadEntries: loadDecryptedEntries,
		showCard: (opts) => showCard(tabId, cardPayload(req, opts)),
	};
	return req.kind === "create" ? runCreateCeremony(req, host) : runGetCeremony(req, host);
};

async function sha256Base64(bytes: Uint8Array): Promise<string> {
	// Copy into a fresh ArrayBuffer-backed view so the type is a plain BufferSource.
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
	return bytesToBase64(new Uint8Array(digest));
}

const productionDeps: PasskeyProxyDeps = {
	crypto: { passkeyMakeCredential, passkeyGetAssertion },
	loadEntries: loadDecryptedEntries,
	savePlacement,
	ceremony: cornerCeremony,
	sha256: sha256Base64,
	now: () => Date.now(),
	// Confirm the save in any open extension page (the popup is open during Unlock & Save).
	onSaved: (info) => {
		void api.runtime.sendMessage({ type: "PASSKEY_SAVED", payload: info }).catch(() => {});
	},
};

on("PASSKEY_PROMPT_RESPONSE", async (message) => {
	const { promptId, approved, choice } = (message.payload ?? {}) as PasskeyPromptResponse;
	const resolve = pendingPrompts.get(promptId);
	if (resolve) {
		pendingPrompts.delete(promptId);
		resolve({ approved: !!approved, choice });
	}
	return { ok: true, data: null };
});

// Settings toggle: attach/detach now. The pref itself is persisted by usePrefs (same
// chrome.storage.local key the background reads on startup), so this only applies it live.
on("PASSKEY_PROVIDER_SET_ENABLED", async (message) => {
	const { enabled } = (message.payload ?? {}) as { enabled?: boolean };
	await setPasskeyProviderEnabled(!!enabled);
	return { ok: true, data: null };
});

// Pause the proxy while Bramble runs its OWN WebAuthn (security-key PRF) ceremony, so
// attach()'s browser-wide interception doesn't hijack our unlock. The popup/options send
// PAUSE before navigator.credentials and RESUME after (see webauthn-ceremony pauser).
// Reentrant: createPrfCredential nests a get() inside create(), so count depth and only
// detach/reattach at the edges. See docs/passkey-provider.md.
let pauseDepth = 0;
let pausedWhileAttached = false;

on("PASSKEY_PROXY_PAUSE", async () => {
	if (pauseDepth === 0 && attached) {
		pausedWhileAttached = true;
		await detachWebauthnProxy();
	}
	pauseDepth++;
	return { ok: true, data: null };
});

on("PASSKEY_PROXY_RESUME", async () => {
	if (pauseDepth > 0) pauseDepth--;
	if (pauseDepth === 0 && pausedWhileAttached) {
		pausedWhileAttached = false;
		await initWebauthnProxy();
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
		void (async () => {
			const origin = await activeTabOrigin();
			const details = origin
				? await handleCreate(productionDeps, req.requestId, req.requestDetailsJson, origin)
				: {
						requestId: req.requestId,
						error: { name: "NotAllowedError", message: "no resolvable tab origin" },
					};
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
		void (async () => {
			const origin = await activeTabOrigin();
			const details = origin
				? await handleGet(productionDeps, req.requestId, req.requestDetailsJson, origin)
				: {
						requestId: req.requestId,
						error: { name: "NotAllowedError", message: "no resolvable tab origin" },
					};
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

/**
 * Attach the proxy (registering listeners once). Gated behind a Settings pref (default
 * off): attach() intercepts ALL browser WebAuthn, including Bramble's own security-key
 * unlock, which is why we pause around our own ceremonies. End-to-end needs a real Chrome.
 */
export async function initWebauthnProxy(): Promise<void> {
	if (typeof api.webAuthenticationProxy === "undefined") return; // Firefox: no proxy API
	registerListeners();
	if (attached) return;
	const err = await api.webAuthenticationProxy.attach();
	if (err) throw new Error(`webAuthenticationProxy.attach failed: ${err}`);
	attached = true;
}

export async function detachWebauthnProxy(): Promise<void> {
	if (!attached) return;
	await api.webAuthenticationProxy.detach();
	attached = false;
}

/** Runtime toggle from Settings. */
export async function setPasskeyProviderEnabled(enabled: boolean): Promise<void> {
	if (enabled) await initWebauthnProxy();
	else await detachWebauthnProxy();
}
