/// <reference types="chrome" />

// Firefox delivery for the passkey provider. Firefox has no chrome.webAuthenticationProxy,
// so a MAIN-world content script (content/webauthn-inpage.ts) overrides
// navigator.credentials.create/get and forwards the options here via the isolated bridge.
// These handlers drive the SAME transport-free ceremony handlers Chrome uses
// (handleCreate/handleGet), so only the delivery differs. See docs/firefox-port.md.
//
// Origin: taken from the message sender (browser-set, per-frame), which is authoritative
// and cannot be forged by the page.
//
// The response envelope's `data` tells the in-page shim what to do:
//  - { passthrough: true }  -> call the native navigator.credentials (provider off, or an
//                              origin we won't serve); never breaks the page's WebAuthn.
//  - { error: {name,message} } -> throw a DOMException of that name (e.g. user declined).
//  - { responseJson }       -> rebuild a synthetic PublicKeyCredential for the page.

import { api } from "../platform-api";
import { on } from "./router";
import type { RequestCaller } from "./webauthn-json";
import { depsForTab, isProviderEnabled } from "./webauthn-provider";
import { handleCreate, handleGet } from "./webauthn-proxy";

type TransportResult =
	| { passthrough: true }
	| { error: { name: string; message: string } }
	| { responseJson: string };

/** Map a handler's response details to the shim's transport result. */
function toTransportResult(details: {
	error?: { name: string; message: string };
	responseJson?: string;
	passthrough?: true;
}): TransportResult {
	if (details.passthrough) return { passthrough: true };
	if (details.error) return { error: { name: details.error.name, message: details.error.message } };
	if (details.responseJson) return { responseJson: details.responseJson };
	return { error: { name: "NotAllowedError", message: "no passkey response" } };
}

function webOrigin(raw: string | undefined): string | null {
	if (!raw) return null;
	try {
		const u = new URL(raw);
		return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
	} catch {
		return null;
	}
}

/**
 * The requester (browser-set sender) and its tab, or null to pass through to the native
 * authenticator. The bridge runs in every frame and a frame can post to it directly, skipping the
 * MAIN-world canIntercept gate, so the same rule is enforced here: the top frame, or a frame
 * same-origin with it. A cross-origin child goes native, which honours the Permissions Policy.
 */
export function senderCaller(
	sender: chrome.runtime.MessageSender,
): { caller: RequestCaller; tabId: number } | null {
	const origin = webOrigin(sender.origin ?? sender.url);
	const tabId = sender.tab?.id;
	if (!origin || tabId === undefined) return null;
	if (sender.frameId !== 0 && origin !== webOrigin(sender.tab?.url)) return null;
	return { caller: { origin, crossOrigin: false }, tabId };
}

// Register only on Firefox (no proxy API). On Chrome the MAIN-world script is never
// injected, so these would be dead handlers; guarding keeps the Chrome path clean.
if (typeof api.webAuthenticationProxy === "undefined") {
	for (const [type, handle] of [
		["WEBAUTHN_CREATE", handleCreate],
		["WEBAUTHN_GET", handleGet],
	] as const) {
		on(type, async (message, sender): Promise<{ ok: true; data: TransportResult }> => {
			const bound = isProviderEnabled() ? senderCaller(sender) : null;
			if (!bound) return { ok: true, data: { passthrough: true } };
			const json = JSON.stringify(message.payload ?? {});
			const details = await handle(depsForTab(bound.tabId), 0, json, bound.caller);
			return { ok: true, data: toTransportResult(details) };
		});
	}
}
