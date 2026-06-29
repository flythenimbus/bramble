/// <reference types="chrome" />

// Production wiring for the passkey provider: builds the deps the pure handlers in
// ./webauthn-proxy consume (corner-card ceremony, vault IO, crypto, sha256), registers
// the PASSKEY_PROMPT_RESPONSE resolver, and attaches the proxy. Split out so
// ./webauthn-proxy stays import-safe (no chrome at import) and unit-testable. The
// ceremony reuses the save-login corner card placement. See docs/passkey-provider.md.

import type { PasskeyPromptResponse, SavePasskeyPrompt } from "@core/adapters/autofill";
import { bytesToBase64 } from "@core/util/bytes";
import { findLoginCoveringRpId } from "@core/vault/passkey";
import {
	loadDecryptedEntries,
	passkeyGetAssertion,
	passkeyMakeCredential,
	savePlacement,
} from "./passkey-store";
import { on } from "./router";
import { vaultLocked } from "./session";
import { type CeremonyFn, handleCreate, handleGet, type PasskeyProxyDeps } from "./webauthn-proxy";

const CEREMONY_TIMEOUT_MS = 120_000;
const UNLOCK_TIMEOUT_MS = 90_000;

// In-flight passkey ceremonies keyed by promptId; resolved by PASSKEY_PROMPT_RESPONSE.
const pendingPrompts = new Map<string, (approved: boolean) => void>();

async function activeTabId(): Promise<number | undefined> {
	try {
		const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
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
		const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
		if (!tab?.url) return null;
		const u = new URL(tab.url);
		return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
	} catch {
		return null;
	}
}

async function openPopupForUnlock(): Promise<void> {
	try {
		const openPopup = (chrome.action as unknown as { openPopup?: () => Promise<void> }).openPopup;
		if (typeof openPopup === "function") {
			await openPopup.call(chrome.action);
			return;
		}
	} catch {}
	try {
		await chrome.windows.create({
			url: chrome.runtime.getURL("popup.html?detached=1"),
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

// Show the save/use-passkey card (same corner placement as save-login) and await the
// user's choice; if the vault is locked, open the popup and wait for the unlock.
const cornerCeremony: CeremonyFn = async (req) => {
	const tabId = await activeTabId();
	if (tabId === undefined) return { approved: false };
	const promptId = globalThis.crypto.randomUUID();
	// For a create, when the vault is already unlocked, surface the existing login this
	// passkey will attach to so the card can say "Add to your existing X login". When
	// locked we can't read the vault yet, so the card stays the generic "Save" copy.
	let existingLoginName: string | undefined;
	if (req.kind === "create" && !vaultLocked()) {
		try {
			existingLoginName = findLoginCoveringRpId(await loadDecryptedEntries(), req.rpId)?.name;
		} catch {}
	}
	const payload: SavePasskeyPrompt = {
		kind: "save-passkey",
		promptId,
		hostname: req.rpId,
		locked: vaultLocked(),
		intent: req.kind,
		rpId: req.rpId,
		rpName: req.kind === "create" ? req.rpName : undefined,
		userName: req.kind === "create" ? req.userName : undefined,
		existingLoginName,
	};
	const approved = await new Promise<boolean>((resolve) => {
		pendingPrompts.set(promptId, resolve);
		chrome.tabs.sendMessage(tabId, { type: "CORNER_PROMPT_SHOW", payload }).catch(() => {
			if (pendingPrompts.delete(promptId)) resolve(false);
		});
		setTimeout(() => {
			if (pendingPrompts.delete(promptId)) resolve(false);
		}, CEREMONY_TIMEOUT_MS);
	});
	if (!approved) return { approved: false };
	if (vaultLocked()) {
		await openPopupForUnlock();
		if (!(await waitForUnlock(UNLOCK_TIMEOUT_MS))) return { approved: false };
	}
	// Unlocking the vault (master password / biometric) is the user verification.
	return { approved: true, userVerified: true };
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
};

on("PASSKEY_PROMPT_RESPONSE", async (message) => {
	const { promptId, approved } = (message.payload ?? {}) as PasskeyPromptResponse;
	const resolve = pendingPrompts.get(promptId);
	if (resolve) {
		pendingPrompts.delete(promptId);
		resolve(!!approved);
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
	if (listenersRegistered) return;
	listenersRegistered = true;
	chrome.webAuthenticationProxy.onIsUvpaaRequest.addListener((req) => {
		chrome.webAuthenticationProxy.completeIsUvpaaRequest({
			requestId: req.requestId,
			isUvpaa: true,
		});
	});
	chrome.webAuthenticationProxy.onCreateRequest.addListener((req) => {
		void (async () => {
			const origin = await activeTabOrigin();
			const details = origin
				? await handleCreate(productionDeps, req.requestId, req.requestDetailsJson, origin)
				: {
						requestId: req.requestId,
						error: { name: "NotAllowedError", message: "no resolvable tab origin" },
					};
			await chrome.webAuthenticationProxy.completeCreateRequest(details);
		})();
	});
	chrome.webAuthenticationProxy.onGetRequest.addListener((req) => {
		void (async () => {
			const origin = await activeTabOrigin();
			const details = origin
				? await handleGet(productionDeps, req.requestId, req.requestDetailsJson, origin)
				: {
						requestId: req.requestId,
						error: { name: "NotAllowedError", message: "no resolvable tab origin" },
					};
			await chrome.webAuthenticationProxy.completeGetRequest(details);
		})();
	});
}

/**
 * Attach the proxy (registering listeners once). Gated behind a Settings pref (default
 * off): attach() intercepts ALL browser WebAuthn, including Bramble's own security-key
 * unlock, which is why we pause around our own ceremonies. End-to-end needs a real Chrome.
 */
export async function initWebauthnProxy(): Promise<void> {
	registerListeners();
	if (attached) return;
	const err = await chrome.webAuthenticationProxy.attach();
	if (err) throw new Error(`webAuthenticationProxy.attach failed: ${err}`);
	attached = true;
}

export async function detachWebauthnProxy(): Promise<void> {
	if (!attached) return;
	await chrome.webAuthenticationProxy.detach();
	attached = false;
}

/** Runtime toggle from Settings. */
export async function setPasskeyProviderEnabled(enabled: boolean): Promise<void> {
	if (enabled) await initWebauthnProxy();
	else await detachWebauthnProxy();
}
