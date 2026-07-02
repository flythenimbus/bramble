/// <reference types="chrome" />

// Firefox passkey provider: the isolated-world relay. The MAIN-world override
// (webauthn-inpage.ts) can't reach extension APIs, so it postMessages requests here and
// this bridge forwards them to the background over runtime.sendMessage, then postMessages
// the reply back. Runs at document_start (Firefox only) so it's listening before a page
// that calls navigator.credentials early. See docs/firefox-port.md.
//
// This is NOT a trust boundary: the page shares this frame's realm and could post its own
// messages, but the background derives the rpId-binding origin from the browser-set sender
// (not anything here), so a page can at most craft a request for its OWN origin — exactly
// what it is already allowed to do. Kept import-free so the content bundle stays a single
// flat file (classic content scripts can't import chunks).

const api = ((globalThis as { browser?: typeof chrome }).browser ??
	(globalThis as { chrome?: typeof chrome }).chrome) as typeof chrome;

interface Req {
	__bramble_pk: "req";
	id: string;
	method: "create" | "get";
	payload: unknown;
}

function isReq(d: unknown): d is Req {
	return (
		typeof d === "object" &&
		d !== null &&
		(d as Req).__bramble_pk === "req" &&
		typeof (d as Req).id === "string" &&
		((d as Req).method === "create" || (d as Req).method === "get")
	);
}

window.addEventListener("message", (ev: MessageEvent) => {
	// Same-frame only: the MAIN world posts with source === this window.
	if (ev.source !== window) return;
	const d = ev.data;
	if (!isReq(d)) return;
	const type = d.method === "create" ? "WEBAUTHN_CREATE" : "WEBAUTHN_GET";
	const reply = (result: unknown) =>
		window.postMessage({ __bramble_pk: "res", id: d.id, result }, ev.origin || "*");

	void Promise.resolve()
		.then(() => api.runtime.sendMessage({ type, payload: d.payload }))
		.then((resp: unknown) => {
			const env = resp as { ok?: boolean; data?: unknown } | undefined;
			// A handler that ran returns its transport result in `data`; anything else
			// (no handler, provider off before the flag loaded) falls back to native.
			reply(env?.ok && env.data ? env.data : { passthrough: true });
		})
		// Extension context torn down / no listener: let the page's native authenticator
		// handle it rather than breaking the ceremony.
		.catch(() => reply({ passthrough: true }));
});
