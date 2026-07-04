/// <reference types="chrome" />

// Firefox delivery for the passkey provider. Firefox has no chrome.webAuthenticationProxy,
// so a MAIN-world content script (content/webauthn-inpage.ts) overrides
// navigator.credentials.create/get and forwards the options here via the isolated bridge.
// These handlers drive the SAME transport-free ceremony handlers Chrome uses
// (handleCreate/handleGet), so only the delivery differs. See docs/firefox-port.md.
//
// Origin: taken from the message sender (browser-set, per-frame), which is authoritative
// and cannot be forged by the page. This is strictly better than the Chrome proxy, which
// has to guess the requester from the active tab.
//
// The response envelope's `data` tells the in-page shim what to do:
//  - { passthrough: true }  -> call the native navigator.credentials (provider off, or an
//                              origin we won't serve); never breaks the page's WebAuthn.
//  - { error: {name,message} } -> throw a DOMException of that name (e.g. user declined).
//  - { responseJson }       -> rebuild a synthetic PublicKeyCredential for the page.

import { api } from "../platform-api";
import { on } from "./router";
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
}): TransportResult {
	if (details.error) return { error: { name: details.error.name, message: details.error.message } };
	if (details.responseJson) return { responseJson: details.responseJson };
	return { error: { name: "NotAllowedError", message: "no passkey response" } };
}

/** The requesting frame's web origin, from the browser-set sender. Null for non-web frames. */
function senderOrigin(sender: chrome.runtime.MessageSender): string | null {
	const raw = sender.origin ?? sender.url ?? sender.tab?.url;
	if (!raw) return null;
	try {
		const u = new URL(raw);
		return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
	} catch {
		return null;
	}
}

// Register only on Firefox (no proxy API). On Chrome the MAIN-world script is never
// injected, so these would be dead handlers; guarding keeps the Chrome path clean.
if (typeof api.webAuthenticationProxy === "undefined") {
	on("WEBAUTHN_CREATE", async (message, sender): Promise<{ ok: true; data: TransportResult }> => {
		if (!isProviderEnabled()) return { ok: true, data: { passthrough: true } };
		const origin = senderOrigin(sender);
		if (!origin) return { ok: true, data: { passthrough: true } };
		const json = JSON.stringify(message.payload ?? {});
		const details = await handleCreate(depsForTab(sender.tab?.id), 0, json, origin);
		return { ok: true, data: toTransportResult(details) };
	});

	on("WEBAUTHN_GET", async (message, sender): Promise<{ ok: true; data: TransportResult }> => {
		if (!isProviderEnabled()) return { ok: true, data: { passthrough: true } };
		const origin = senderOrigin(sender);
		if (!origin) return { ok: true, data: { passthrough: true } };
		const json = JSON.stringify(message.payload ?? {});
		const details = await handleGet(depsForTab(sender.tab?.id), 0, json, origin);
		return { ok: true, data: toTransportResult(details) };
	});
}
