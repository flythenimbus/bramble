/// <reference types="chrome" />

// Transport-agnostic passkey-provider wiring: the corner-card ceremony, popup unlock,
// vault IO, crypto, and the enabled flag that both delivery paths share. The pure
// handlers (handleCreate/handleGet in ./webauthn-proxy) consume the deps built here.
//
// Two deliveries drive the same deps:
//  - Chrome: chrome.webAuthenticationProxy (./webauthn-proxy-init), with the origin from
//    Chrome's own stamp on each proxied request.
//  - Firefox: a MAIN-world content script (./webauthn-content-transport) that overrides
//    navigator.credentials and forwards, with the origin from the message sender.
// See docs/passkey-provider.md and docs/firefox-port.md.

import type { PasskeyPromptResponse, SavePasskeyPrompt } from "@core/adapters/autofill";
import { bytesToBase64 } from "@core/util/bytes";
import { api } from "../platform-api";
import {
	loadDecryptedEntries,
	passkeyGetAssertion,
	passkeyMakeCredential,
	passkeyPrfEval,
	savePlacement,
} from "./passkey-store";
import { openPopoutAt, openUnlockView } from "./popout";
import { getPasskeyConfirmOncePerUnlock, getPasskeyProviderEnabled } from "./prefs";
import { extensionOnly, on } from "./router";
import { vaultLocked } from "./session";
import {
	type CeremonyFn,
	type CeremonyHost,
	type CeremonyRequest,
	type PasskeyProxyDeps,
	runCreateCeremony,
	runGetCeremony,
} from "./webauthn-proxy";

// One budget for a whole ceremony (cards and unlock together), under the Firefox page's 180 s
// backstop: the page must never give up while a ceremony could still save a passkey.
const CEREMONY_DEADLINE_MS = 150_000;

type PromptReply = { approved: boolean; choice?: string };
// In-flight passkey cards keyed by promptId; resolved by PASSKEY_PROMPT_RESPONSE.
const pendingPrompts = new Map<string, (reply: PromptReply) => void>();

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
function showCard(
	tabId: number,
	payload: SavePasskeyPrompt,
	timeoutMs: number,
): Promise<PromptReply> {
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
		}, timeoutMs);
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
		requester: new URL(req.origin).hostname,
		userName: req.kind === "create" ? req.userName : undefined,
		...extra,
	};
}

type VerifyOutcome = { verified: boolean; keepWindow: boolean };
// Confirm-it's-you windows awaiting an answer, keyed by a per-request id; PASSKEY_VERIFY_RESULT
// settles them.
const pendingVerifications = new Map<
	string,
	{ settle: (outcome: VerifyOutcome) => void; requestGone: () => boolean }
>();

// A key tap detaches Chrome's proxy, ending the site's request (docs/passkey-provider.md). The tap
// still verified the user, so that site's next try uses it: once, and only briefly.
const RETRY_GRANT_MS = 60_000;
let retryGrant: { origin: string; rpId: string; until: number } | null = null;

function takeRetryGrant(req: CeremonyRequest): boolean {
	if (
		!retryGrant ||
		retryGrant.origin !== req.origin ||
		retryGrant.rpId !== req.rpId ||
		Date.now() >= retryGrant.until
	) {
		return false;
	}
	retryGrant = null;
	return true;
}

// Ask the user to confirm it's them in a detached window (master password or a key), for a request
// that needs verification while the vault is already unlocked. Timeout counts as no.
async function verifyUser(
	req: CeremonyRequest,
	timeoutMs: number,
	requestGone: () => boolean,
): Promise<boolean> {
	if (takeRetryGrant(req)) return true;
	const id = globalThis.crypto.randomUUID();
	const answer = new Promise<VerifyOutcome>((resolve) => {
		pendingVerifications.set(id, { settle: resolve, requestGone });
		setTimeout(() => {
			if (pendingVerifications.delete(id)) resolve({ verified: false, keepWindow: false });
		}, timeoutMs);
	});
	const windowId = await openPopoutAt(
		`/passkey-verify?${new URLSearchParams({ id, rp: req.rpId })}`,
	);
	const { verified, keepWindow } = await answer;
	if (windowId !== undefined && !keepWindow) await api.windows.remove(windowId).catch(() => {});
	return verified;
}

// Only an extension page may answer: content scripts run inside pages we don't control.
on(
	"PASSKEY_VERIFY_RESULT",
	extensionOnly(async (message) => {
		const { id, verified } = (message.payload ?? {}) as { id?: string; verified?: boolean };
		const pending = id ? pendingVerifications.get(id) : undefined;
		let signInAgain = false;
		if (id && pending) {
			pendingVerifications.delete(id);
			signInAgain = verified === true && pending.requestGone();
			pending.settle({ verified: verified === true, keepWindow: signInAgain });
		}
		return { ok: true, data: { signInAgain } };
	}),
);

// Open the popup so a user gesture can unlock the vault, then wait until it is unlocked.
async function ensureUnlocked(timeoutMs: number): Promise<boolean> {
	if (!vaultLocked()) return true;
	const unlockWindowId = await openUnlockView();
	const ok = await waitForUnlock(timeoutMs);
	// Close the unlock window once we're in, so it doesn't sit on top of the page's corner
	// prompt (the passkey picker / confirmation that runs next).
	if (ok && unlockWindowId !== undefined) {
		await api.windows.remove(unlockWindowId).catch(() => {});
	}
	return ok;
}

// The corner card has one slot, so a second concurrent ceremony is declined rather than allowed
// to replace the first's card (which then could only auto-decline at its deadline).
let ceremonyInProgress = false;

/** The corner-card ceremony, shown in `tabId`: the tab its transport bound the request to. */
function cornerCeremonyForTab(tabId: number, requestGone: () => boolean): CeremonyFn {
	return async (req) => {
		if (ceremonyInProgress) return { approved: false };
		ceremonyInProgress = true;
		try {
			const deadline = Date.now() + CEREMONY_DEADLINE_MS;
			const remaining = () => Math.max(0, deadline - Date.now());
			// Snapshot the lock state up front so the ceremony's locked-branch UX (confirm card
			// then unlock) is decided once, not re-read mid-flow.
			const startedLocked = vaultLocked();
			const host: CeremonyHost = {
				isLocked: () => startedLocked,
				ensureUnlocked: () => ensureUnlocked(remaining()),
				unlockVerifies: await getPasskeyConfirmOncePerUnlock(),
				verifyUser: () => verifyUser(req, remaining(), requestGone),
				loadEntries: loadDecryptedEntries,
				showCard: (opts) => showCard(tabId, cardPayload(req, opts), remaining()),
			};
			const decision = await (req.kind === "create"
				? runCreateCeremony(req, host)
				: runGetCeremony(req, host));
			if (decision.approved && decision.userVerified && requestGone()) {
				retryGrant = { origin: req.origin, rpId: req.rpId, until: Date.now() + RETRY_GRANT_MS };
			}
			return decision;
		} finally {
			ceremonyInProgress = false;
		}
	};
}

async function sha256Base64(bytes: Uint8Array): Promise<string> {
	// Copy into a fresh ArrayBuffer-backed view so the type is a plain BufferSource.
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
	return bytesToBase64(new Uint8Array(digest));
}

/** Deps for the pure handlers, with the ceremony's card bound to `tabId`. `requestGone`: the site's request has already ended. */
export function depsForTab(
	tabId: number,
	requestGone: () => boolean = () => false,
): PasskeyProxyDeps {
	return {
		crypto: { passkeyMakeCredential, passkeyGetAssertion, passkeyPrfEval },
		loadEntries: loadDecryptedEntries,
		savePlacement,
		ceremony: cornerCeremonyForTab(tabId, requestGone),
		sha256: sha256Base64,
		now: () => Date.now(),
		// Confirm the save in any open extension page (the popup is open during Unlock & Save).
		onSaved: (info) => {
			void api.runtime.sendMessage({ type: "PASSKEY_SAVED", payload: info }).catch(() => {});
		},
	};
}

// ---- enabled flag (shared by both deliveries) ----

// Off by default: on Chrome attaching the proxy intercepts ALL browser WebAuthn; on
// Firefox the MAIN-world override is always injected, so this flag is what makes it
// pass through to the native authenticator when the user hasn't opted in.
let providerEnabled = false;
export function isProviderEnabled(): boolean {
	return providerEnabled;
}

// Set once the user has toggled explicitly, so a slower startup read cannot overwrite the newer
// choice. Belt and braces alongside folding the load into `hydrated`: this holds even if some
// future caller reads the pref off the hydration path.
let flagSetExplicitly = false;

/** Load the persisted pref into the in-memory flag (called once at startup). */
export async function loadProviderEnabled(): Promise<void> {
	const stored = await getPasskeyProviderEnabled();
	if (!flagSetExplicitly) providerEnabled = stored;
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
	const previous = providerEnabled;
	providerEnabled = !!enabled;
	flagSetExplicitly = true;
	try {
		await applyHook(!!enabled);
	} catch (e) {
		// Chrome's attach() can fail outright when another extension holds the proxy. Restore the
		// old value rather than reordering the assignment, because Firefox's hook is a no-op and
		// the flag alone is what gates its transport there.
		providerEnabled = previous;
		throw e;
	}
	return { ok: true, data: null };
});
