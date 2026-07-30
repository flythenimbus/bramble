/// <reference types="chrome" />

// Transport-agnostic passkey-provider wiring: the corner-card ceremony, popup unlock,
// vault IO, crypto, and the enabled flag that both delivery paths share. The pure
// handlers (handleCreate/handleGet in ./webauthn-proxy) consume the deps built here.
//
// Two deliveries drive the same deps:
//  - Chrome: chrome.webAuthenticationProxy (./webauthn-proxy-init) — attaches to the
//    browser and recovers the origin from the active tab.
//  - Firefox: a MAIN-world content script (./webauthn-content-transport) — overrides
//    navigator.credentials and forwards, with the origin coming from the message sender.
// See docs/passkey-provider.md and docs/firefox-port.md.

import type { PasskeyPromptResponse, SavePasskeyPrompt } from "@core/adapters/autofill";
import { bytesToBase64 } from "@core/util/bytes";
import { api } from "../platform-api";
import {
	loadDecryptedEntries,
	passkeyGetAssertion,
	passkeyMakeCredential,
	savePlacement,
} from "./passkey-store";
import { getPasskeyProviderEnabled } from "./prefs";
import { on } from "./router";
import { vaultLocked } from "./session";
import {
	type CeremonyFn,
	type CeremonyHost,
	type CeremonyRequest,
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

/** Open the unlock UI. Returns the detached window's id so it can be closed once unlocked
 *  (so it doesn't cover the page's corner prompt); undefined when the browser-action popup
 *  was used instead (it dismisses on its own). */
async function openPopupForUnlock(): Promise<number | undefined> {
	try {
		const openPopup = (api.action as { openPopup?: () => Promise<void> }).openPopup;
		if (typeof openPopup === "function") {
			await openPopup.call(api.action);
			return undefined;
		}
	} catch {}
	try {
		const win = await api.windows.create({
			url: api.runtime.getURL("popup.html?detached=1"),
			type: "popup",
			focused: true,
			width: 500,
			height: 600,
		});
		return win?.id;
	} catch {}
	return undefined;
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
		// Top frame only (where the corner card renders), matching the save-login prompt.
		api.tabs
			.sendMessage(tabId, { type: "CORNER_PROMPT_SHOW", payload }, { frameId: 0 })
			.catch(() => {
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

// Open the popup so a user gesture can unlock the vault, then wait until it is unlocked.
async function ensureUnlocked(): Promise<boolean> {
	if (!vaultLocked()) return true;
	const unlockWindowId = await openPopupForUnlock();
	const ok = await waitForUnlock(UNLOCK_TIMEOUT_MS);
	// Close the unlock window once we're in, so it doesn't sit on top of the page's corner
	// prompt (the passkey picker / confirmation that runs next).
	if (ok && unlockWindowId !== undefined) {
		await api.windows.remove(unlockWindowId).catch(() => {});
	}
	return ok;
}

/**
 * Build the corner-card ceremony bound to a tab. Chrome's proxy has no sender tab and
 * passes nothing (falls back to the active tab); Firefox's content transport passes the
 * exact `sender.tab.id`, so the card lands in the requesting tab even if focus moved.
 */
function cornerCeremonyForTab(explicitTabId?: number): CeremonyFn {
	return async (req) => {
		const tabId = explicitTabId ?? (await activeTabId());
		if (tabId === undefined) return { approved: false };
		// Snapshot the lock state up front so the ceremony's locked-branch UX (confirm card
		// then unlock) is decided once, not re-read mid-flow.
		const startedLocked = vaultLocked();
		const host: CeremonyHost = {
			isLocked: () => startedLocked,
			ensureUnlocked,
			loadEntries: loadDecryptedEntries,
			showCard: (opts) => showCard(tabId, cardPayload(req, opts)),
		};
		return req.kind === "create" ? runCreateCeremony(req, host) : runGetCeremony(req, host);
	};
}

async function sha256Base64(bytes: Uint8Array): Promise<string> {
	// Copy into a fresh ArrayBuffer-backed view so the type is a plain BufferSource.
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
	return bytesToBase64(new Uint8Array(digest));
}

/** Deps for the pure handlers, with the ceremony bound to a known tab (Firefox) or the active tab. */
export function depsForTab(tabId?: number): PasskeyProxyDeps {
	return {
		crypto: { passkeyMakeCredential, passkeyGetAssertion },
		loadEntries: loadDecryptedEntries,
		savePlacement,
		ceremony: cornerCeremonyForTab(tabId),
		sha256: sha256Base64,
		now: () => Date.now(),
		// Confirm the save in any open extension page (the popup is open during Unlock & Save).
		onSaved: (info) => {
			void api.runtime.sendMessage({ type: "PASSKEY_SAVED", payload: info }).catch(() => {});
		},
	};
}

/** The Chrome-proxy deps (ceremony resolves the active tab; the proxy carries no tab). */
export const productionDeps: PasskeyProxyDeps = depsForTab();

// ---- enabled flag (shared by both deliveries) ----

// Off by default: on Chrome attaching the proxy intercepts ALL browser WebAuthn; on
// Firefox the MAIN-world override is always injected, so this flag is what makes it
// pass through to the native authenticator when the user hasn't opted in.
let providerEnabled = false;
export function isProviderEnabled(): boolean {
	return providerEnabled;
}

/** Load the persisted pref into the in-memory flag (called once at startup). */
export async function loadProviderEnabled(): Promise<void> {
	providerEnabled = await getPasskeyProviderEnabled();
}

// The delivery-specific side effect of toggling (Chrome: attach/detach; Firefox: none).
type ApplyHook = (enabled: boolean) => Promise<void>;
let applyHook: ApplyHook = async () => {};
export function setProviderApplyHook(fn: ApplyHook): void {
	applyHook = fn;
}

on("PASSKEY_PROMPT_RESPONSE", async (message) => {
	const { promptId, approved, choice } = (message.payload ?? {}) as PasskeyPromptResponse;
	const resolve = pendingPrompts.get(promptId);
	if (resolve) {
		pendingPrompts.delete(promptId);
		resolve({ approved: !!approved, choice });
	}
	return { ok: true, data: null };
});

// Settings toggle: persist happens in usePrefs; this applies it live. The flag gates
// both deliveries; the hook does the Chrome-only attach/detach.
on("PASSKEY_PROVIDER_SET_ENABLED", async (message) => {
	const { enabled } = (message.payload ?? {}) as { enabled?: boolean };
	providerEnabled = !!enabled;
	await applyHook(!!enabled);
	return { ok: true, data: null };
});
