/// <reference types="chrome" />

// Field-frame side of the relayed picker. The iframe ELEMENT lives in the top frame
// (see relay-host.ts), but the conversation with the UI document stays here, so the
// trust model is the same one the non-relayed picker has always used: summaries go to
// a window we pinned by origin, and a pick is honoured only when it comes back from
// that same window. See docs/autofill.md.
//
// SECURITY, in the order it matters:
//  1. The UI window is pinned from an announcement whose `event.origin` is one of OUR
//     extension origins. `origin` is browser-set, so no page can impersonate it.
//  2. Summaries are posted to that pinned window with an exact targetOrigin, never
//     "*", so they are delivered to the UI document alone.
//  3. An inbound message is honoured only when `event.source` is the pinned window AND
//     `event.origin` is the pinned origin. A page shares its frame's window, so it can
//     forge neither.
//  4. A pick must name an entry we actually rendered. The UI document is treated as
//     untrusted plumbing: anything else in the tab can post to it, so its output is
//     range-checked here rather than trusted.
// Secrets never travel any of this. The pick is only an id; the fill still goes
// through AUTOFILL_SELECT on this frame's own verified background channel.

import { isExtensionOrigin } from "./ext-origin";
import type { FrameRelay, RelayRect } from "./frame-relay";
import type { MatchSummary } from "./types";

// The UI announces itself; this frame cannot go looking for it. `window.frames`
// exposes only DOCUMENT-TREE child browsing contexts, and the host parks the UI
// inside a closed shadow root, so it is unreachable by index from here. Reversing
// the handshake keeps that shadow root without weakening anything: the pin is still
// decided by the announcement's browser-set origin.
const HERE = "tp-ui-here";

export type SuggestOpt = { password: string };
export type RelayRender =
	| { kind: "matches"; matches: MatchSummary[]; otpOnly: boolean; suggest?: SuggestOpt }
	| { kind: "locked" };

export interface RelayClientHandlers {
	onPick(entryId: string, otpOnly: boolean): void;
	onPopout(): void;
	onHighlight(active: boolean): void;
	onUseSuggested(): void;
	onRegenerate(): void;
}

let relay: FrameRelay | null = null;
let handlers: RelayClientHandlers | null = null;

let relayId: string | null = null;
let uiWindow: Window | null = null;
let uiOrigin: string | null = null;
let pending: RelayRender | null = null;
// Ids currently on screen. A pick naming anything else is dropped.
let renderedIds = new Set<string>();
let otpOnlyFlag = false;

/** True while a relayed picker is open in an ancestor frame. */
export function relayedPickerIsOpen(): boolean {
	return relayId !== null;
}

/** True once the UI document has announced itself and been pinned. */
export function relayedPickerIsLive(): boolean {
	return uiWindow !== null && uiOrigin !== null;
}

function newRelayId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function post(message: unknown): void {
	if (!uiWindow || !uiOrigin) return;
	try {
		uiWindow.postMessage(message, uiOrigin);
	} catch {
		// The UI frame can be torn down by the host at any moment.
	}
}

function flush(): void {
	if (!pending || !relayedPickerIsLive()) return;
	const render = pending;
	pending = null;
	if (render.kind === "locked") {
		renderedIds = new Set();
		post({ type: "RENDER_LOCKED" });
		return;
	}
	renderedIds = new Set(render.matches.map((m) => m.id));
	otpOnlyFlag = render.otpOnly;
	post({
		type: "RENDER_MATCHES",
		matches: render.matches,
		otpOnly: render.otpOnly,
		suggest: render.suggest,
	});
}

/**
 * Ask an ancestor to host a picker for `rect` and render `render` into it. Repeated
 * calls re-park the existing host rather than opening a second relay.
 */
export function showRelayed(rect: RelayRect, render: RelayRender): void {
	if (!relay) return;
	if (!relayId) relayId = newRelayId();
	pending = render;
	relay.open(relayId, rect);
	// Nothing to do if the UI has not announced yet; `pending` is flushed when it does.
	flush();
}

/** Re-park an open relayed picker as the field moves. */
export function repositionRelayed(rect: RelayRect): void {
	if (relay && relayId) relay.open(relayId, rect);
}

/** Withdraw the relayed picker and forget the UI binding. */
export function closeRelayed(): void {
	if (relay && relayId) relay.close(relayId);
	relayId = null;
	uiWindow = null;
	uiOrigin = null;
	pending = null;
	renderedIds = new Set();
}

/** Forward a navigation key to the relayed UI. */
export function keyToRelayed(key: string): void {
	if (relayedPickerIsLive()) post({ type: "UI_KEY", key });
}

function handleMessage(e: MessageEvent): void {
	if (!relayId) return;
	const data = e.data as { __tp?: string; relayId?: string; type?: string } | undefined;
	if (!data || typeof data !== "object") return;

	// Handshake. Bind only to a window speaking from one of our own origins.
	if (data.__tp === HERE) {
		if (data.relayId !== relayId) return;
		if (!isExtensionOrigin(e.origin)) return;
		if (!e.source) return;
		if (uiWindow && uiWindow !== e.source) return; // already bound
		uiWindow = e.source as Window;
		uiOrigin = e.origin;
		flush();
		return;
	}

	// Everything else must come from the pinned window on the pinned origin.
	if (!uiWindow || e.source !== uiWindow || e.origin !== uiOrigin) return;
	switch (data.type) {
		case "UI_PICK": {
			const entryId = (data as { entryId?: unknown }).entryId;
			// Range-check against what we rendered; the UI is untrusted plumbing.
			if (typeof entryId !== "string" || !renderedIds.has(entryId)) return;
			handlers?.onPick(entryId, otpOnlyFlag);
			break;
		}
		case "UI_HIGHLIGHT":
			handlers?.onHighlight(!!(data as { active?: unknown }).active);
			break;
		case "UI_POPOUT":
			handlers?.onPopout();
			break;
		case "UI_USE_SUGGESTED":
			handlers?.onUseSuggested();
			break;
		case "UI_REGENERATE":
			handlers?.onRegenerate();
			break;
	}
}

/** Wire this frame's relayed-picker channel. Call once, from the content script. */
export function installRelayClient(r: FrameRelay, h: RelayClientHandlers): void {
	relay = r;
	handlers = h;
	window.addEventListener("message", handleMessage);
}

/** Test seam: drop all relay state and listeners. */
export function resetRelayClient(): void {
	closeRelayed();
	window.removeEventListener("message", handleMessage);
	relay = null;
	handlers = null;
}
