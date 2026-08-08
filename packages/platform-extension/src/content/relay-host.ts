/// <reference types="chrome" />

// Top-frame side of the relayed picker. This frame owns only the iframe ELEMENT:
// it creates it, parks it at the relayed rect, applies the height the UI asks for,
// and destroys it. It never sees match summaries or picks, which travel directly
// between the field's frame and the UI document. See docs/autofill.md.
//
// SECURITY: because this frame controls the element's geometry, it also owns the
// anti-clickjacking guard. The non-relayed picker checks trust at pick time, which is
// impossible here (the pick never passes through this frame), so the guard runs
// continuously and tears the host down the moment it stops being legible. You cannot
// click what is not there, and a page cannot suppress the teardown: the verdict comes
// from computed style this frame reads itself, not from any message.

import { api } from "./content-api";
import { isExtensionOrigin } from "./ext-origin";
import type { RelayedAnchor, RelayRect } from "./frame-relay";
import { onTeardown } from "./lifecycle";

const AUTOFILL_UI_URL = api.runtime.getURL("autofill-ui.html");
const MAX_HEIGHT = 400;

function pickerWidth(fieldWidth: number): number {
	return Math.min(Math.max(fieldWidth, 300), 440);
}

type Hosted = {
	relayId: string;
	host: HTMLElement;
	frame: HTMLIFrameElement;
	rect: RelayRect;
};

let hosted: Hosted | null = null;
let watchdog: number | null = null;

/** Legibility guard, mirroring picker.ts pickIsTrustworthy but run continuously. */
function isTrustworthy(host: HTMLElement): boolean {
	const rect = host.getBoundingClientRect();
	if (rect.width < 60 || rect.height < 20) return false;
	if (
		rect.bottom <= 0 ||
		rect.right <= 0 ||
		rect.top >= window.innerHeight ||
		rect.left >= window.innerWidth
	) {
		return false;
	}
	const cs = getComputedStyle(host);
	if (cs.visibility !== "visible" || cs.display === "none") return false;
	if (Number.parseFloat(cs.opacity) < 0.9) return false;
	if (cs.filter !== "none" || cs.mixBlendMode !== "normal" || cs.clipPath !== "none") return false;
	const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
	if (!top) return false;
	return top === host || host.contains(top) || top.contains(host);
}

function position(h: Hosted): void {
	h.host.style.transform = `translate3d(${h.rect.x}px, ${h.rect.y + h.rect.height + 2}px, 0)`;
	h.host.style.width = `${pickerWidth(h.rect.width)}px`;
}

function stopWatchdog(): void {
	if (watchdog !== null) {
		cancelAnimationFrame(watchdog);
		watchdog = null;
	}
}

/** Drop the hosted picker. Called on withdrawal, teardown, or a failed trust check. */
export function destroyRelayHost(): void {
	stopWatchdog();
	if (hosted) {
		hosted.host.remove();
		hosted = null;
	}
}

// A zero-height frame is the normal pre-render state, so the guard only starts
// policing once the UI has reported a real height.
function startWatchdog(): void {
	if (watchdog !== null) return;
	const tick = (): void => {
		watchdog = null;
		if (!hosted) return;
		const measurable = hosted.frame.getBoundingClientRect().height >= 20;
		if (measurable && !isTrustworthy(hosted.host)) {
			destroyRelayHost();
			return;
		}
		watchdog = requestAnimationFrame(tick);
	};
	watchdog = requestAnimationFrame(tick);
}

/** Create or re-park the hosted picker for a descendant's relayed anchor. */
export function showRelayHost(anchor: RelayedAnchor): void {
	if (hosted && hosted.relayId !== anchor.relayId) destroyRelayHost();
	if (hosted) {
		hosted.rect = anchor.rect;
		position(hosted);
		return;
	}
	const host = document.createElement("div");
	host.id = `tp-${Math.random().toString(36).slice(2, 10)}`;
	host.style.cssText =
		"position: absolute; top: 0; left: 0; z-index: 2147483647; margin: 0; padding: 0; border: 0;";
	const shadow = host.attachShadow({ mode: "closed" });
	const frame = document.createElement("iframe");
	// relayId lets the UI answer the right frame's probe; parentOrigin is only used
	// for the height message back to this frame.
	frame.src = `${AUTOFILL_UI_URL}?relayId=${encodeURIComponent(anchor.relayId)}&parentOrigin=${encodeURIComponent(location.origin)}`;
	frame.setAttribute("scrolling", "no");
	frame.style.cssText =
		"display: block; width: 100%; height: 0; border: 0; margin: 0; background: transparent; color-scheme: light dark;";
	shadow.appendChild(frame);
	document.body.appendChild(host);
	hosted = { relayId: anchor.relayId, host, frame, rect: anchor.rect };
	position(hosted);
	startWatchdog();
}

/** Test seam: the hosted UI frame, which otherwise sits behind a closed shadow root. */
export function hostedFrameForTest(): HTMLIFrameElement | null {
	return hosted?.frame ?? null;
}

/** Withdraw the host for `relayId`, ignoring a stale id from an already-replaced relay. */
export function closeRelayHost(relayId: string): void {
	if (hosted?.relayId === relayId) destroyRelayHost();
}

// The only message this frame accepts from the UI is its height. It must come from
// our own iframe's window on one of our origins; a page posting from its own window
// fails both checks.
window.addEventListener("message", (e) => {
	if (!hosted || e.source !== hosted.frame.contentWindow) return;
	if (!isExtensionOrigin(e.origin)) return;
	const msg = e.data as { type?: string; height?: unknown } | undefined;
	if (msg?.type !== "UI_RESIZE") return;
	const height = Math.max(0, Math.min(MAX_HEIGHT, Number(msg.height) || 0));
	hosted.frame.style.height = `${height}px`;
});

onTeardown(destroyRelayHost);
