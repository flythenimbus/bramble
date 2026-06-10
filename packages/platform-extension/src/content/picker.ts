/// <reference types="chrome" />

import { dropdownItem } from "./html/dropdown-item";
import { dropdownLocked } from "./html/dropdown-locked";
import { dropdownStyles } from "./html/dropdown-styles";
import { onTeardown } from "./lifecycle";
import { html } from "./template";
import type { MatchSummary } from "./types";

// The autofill picker: an extension-origin iframe (primary) with a closed-shadow
// dropdown as the COEP fallback. This module hides the iframe-vs-shadow decision,
// the postMessage bridge + origin checks, the clickjacking guard, positioning,
// and keyboard nav behind the `picker` facade at the bottom.

// User actions are reported via callbacks so this module never messages the
// background or touches the page's display policy directly.
let pickCb: ((entryId: string, otpOnly: boolean) => void) | null = null;
let unlockCb: (() => void) | null = null;
let dismissCb: (() => void) | null = null;

// Anchor field shared by both renderers (the page input the picker sits under).
let anchorField: HTMLInputElement | null = null;

function matchesKey(matches: MatchSummary[]): string {
	let out = "";
	for (const m of matches) out += `${m.id}\0`;
	return out;
}

/** True when a click landed on the anchor field or a `<label>` that routes to it. */
function clickIsOnAnchor(target: Node): boolean {
	if (!anchorField) return false;
	if (target === anchorField || anchorField.contains(target)) return true;
	if (target instanceof Element) {
		const label = target.closest("label");
		if (label) {
			if (anchorField.id && label.htmlFor === anchorField.id) return true;
			if (label.contains(anchorField)) return true;
		}
	}
	return false;
}

/** Anchor a host element below `field`, matching the dropdown's geometry. */
function positionHostElement(el: HTMLElement, field: HTMLInputElement): void {
	const rect = field.getBoundingClientRect();
	el.style.top = `${rect.bottom + window.scrollY + 2}px`;
	el.style.left = `${rect.left + window.scrollX}px`;
	// One third of the field, floored at 240px for readability on narrow fields.
	el.style.width = `${Math.max(rect.width / 3, 240)}px`;
}

// --- Shadow dropdown (COEP fallback renderer) ---

const DROPDOWN_ID = "titanpass-autofill-dropdown";

let dropdownEl: HTMLElement | null = null;
// Joined ids of the rendered matches; lets re-queries with the same set skip
// the remove-and-re-add cycle that caused flicker on dynamic pages.
let openMatchesKey = "";
let openDropdownKind: "matches" | "locked" | null = null;

function removeDropdown(): void {
	if (dropdownEl) {
		dropdownEl.remove();
		dropdownEl = null;
	}
	anchorField = null;
	openMatchesKey = "";
	openDropdownKind = null;
}

function positionDropdown(field: HTMLInputElement): void {
	if (!dropdownEl) return;
	positionHostElement(dropdownEl, field);
}

function mountDropdown(field: HTMLInputElement, bodyHtml: string): ShadowRoot {
	removeDropdown();
	anchorField = field;

	const root = document.createElement("div");
	root.id = DROPDOWN_ID;
	// Inline so positioning doesn't depend on the inner stylesheet parsing first.
	root.style.cssText = "position: absolute; z-index: 2147483647;";
	// Closed: page gets `root.shadowRoot === null`. Listener attaches to the returned shadow.
	const shadow = root.attachShadow({ mode: "closed" });
	shadow.innerHTML = dropdownStyles + bodyHtml;

	dropdownEl = root;
	document.body.appendChild(dropdownEl);
	positionDropdown(field);
	return shadow;
}

/** Renders the match picker anchored to `field`; no-op when matches are unchanged to avoid flicker. */
function buildDropdown(
	matches: MatchSummary[],
	field: HTMLInputElement,
	opts?: { otpOnly?: boolean },
): void {
	if (matches.length === 0) return;

	const key = matchesKey(matches);
	// Same matches/field already showing: keep the existing dropdown to avoid
	// flicker from re-queries on every DOM mutation.
	if (
		dropdownEl &&
		anchorField === field &&
		openDropdownKind === "matches" &&
		openMatchesKey === key
	) {
		positionDropdown(field);
		return;
	}

	const body = html`
		${matches.map((m) => dropdownItem({ ...m }))}
	`;
	const root = mountDropdown(field, body);
	openMatchesKey = key;
	openDropdownKind = "matches";

	// mousedown (not click) beats the field's blur; otherwise focus leaves first
	// and the click never reaches us.
	root.addEventListener("mousedown", (e) => {
		// Only a real user mousedown may pull a secret (no synthetic events).
		if (!e.isTrusted) return;
		const item = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-entry-id]");
		if (!item) return;
		e.preventDefault();
		const id = item.dataset.entryId;
		if (id) pickCb?.(id, opts?.otpOnly === true);
	});
}

function buildLockedDropdown(field: HTMLInputElement): void {
	if (dropdownEl && anchorField === field && openDropdownKind === "locked") {
		positionDropdown(field);
		return;
	}
	const root = mountDropdown(field, dropdownLocked);
	openDropdownKind = "locked";

	// mousedown beats the field's blur; otherwise the row never gets the click.
	root.addEventListener("mousedown", (e) => {
		// Only a genuine user click opens the pop-out.
		if (!e.isTrusted) return;
		const item = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-tp-popout]");
		if (!item) return;
		e.preventDefault();
		removeDropdown();
		unlockCb?.();
	});
}

// --- Iframe renderer (primary); the shadow path above is the COEP fallback. ---

const AUTOFILL_UI_URL = chrome.runtime.getURL("autofill-ui.html");
const EXT_ORIGIN = new URL(AUTOFILL_UI_URL).origin;

type IframeRender =
	| { kind: "matches"; matches: MatchSummary[]; otpOnly: boolean }
	| { kind: "locked" };

// "probe" until the first mount resolves to iframe (READY) or shadow (timeout).
let uiMode: "probe" | "iframe" | "shadow" = "probe";
let iframeHostEl: HTMLElement | null = null;
let iframeEl: HTMLIFrameElement | null = null;
let iframeReady = false;
let pendingRender: IframeRender | null = null;
let readinessTimer: number | null = null;
let iframeMatchesKey = "";
// Whether the iframe has a keyboard-highlighted row (drives Enter-to-pick).
let iframeHasHighlight = false;

/** Hide the iframe host (kept alive for reuse). */
function hideIframe(): void {
	if (iframeHostEl) iframeHostEl.style.display = "none";
	iframeMatchesKey = "";
	iframeHasHighlight = false;
	anchorField = null;
}

/** Tear the iframe host down entirely (extension teardown / COEP fallback). */
function destroyIframeHost(): void {
	if (readinessTimer !== null) {
		clearTimeout(readinessTimer);
		readinessTimer = null;
	}
	if (iframeHostEl) {
		iframeHostEl.remove();
		iframeHostEl = null;
	}
	iframeEl = null;
	iframeReady = false;
	pendingRender = null;
	iframeMatchesKey = "";
	iframeHasHighlight = false;
	anchorField = null;
}

/** Create the iframe host (closed-shadow wrapper around the extension-origin iframe), or un-hide it if it exists. */
function ensureIframeHost(): void {
	if (iframeHostEl) {
		iframeHostEl.style.display = "block";
		return;
	}
	const host = document.createElement("div");
	// Random id: no stable selector for the page to target the host by.
	host.id = `tp-${Math.random().toString(36).slice(2, 10)}`;
	host.style.cssText = "position: absolute; z-index: 2147483647; margin: 0; padding: 0; border: 0;";
	const shadow = host.attachShadow({ mode: "closed" });
	const frame = document.createElement("iframe");
	frame.src = `${AUTOFILL_UI_URL}?parentOrigin=${encodeURIComponent(location.origin)}`;
	frame.setAttribute("scrolling", "no");
	// color-scheme: light dark so the iframe isn't given an opaque Canvas backdrop
	// on dark pages (that bled a halo around the card).
	frame.style.cssText =
		"display: block; width: 100%; height: 0; border: 0; margin: 0; background: transparent; color-scheme: light dark;";
	shadow.appendChild(frame);
	document.body.appendChild(host);
	iframeHostEl = host;
	iframeEl = frame;
	iframeReady = false;
}

function flushPendingRender(): void {
	const win = iframeEl?.contentWindow;
	if (!win || !pendingRender) return;
	const render = pendingRender;
	pendingRender = null;
	if (render.kind === "matches") {
		win.postMessage(
			{ type: "RENDER_MATCHES", matches: render.matches, otpOnly: render.otpOnly },
			EXT_ORIGIN,
		);
	} else {
		win.postMessage({ type: "RENDER_LOCKED" }, EXT_ORIGIN);
	}
}

/** First-mount fallback: if the iframe never reports ready (e.g. COEP blocks it), switch to the shadow renderer. */
function armReadinessTimeout(): void {
	if (readinessTimer !== null || iframeReady) return;
	readinessTimer = window.setTimeout(() => {
		readinessTimer = null;
		if (iframeReady) return;
		uiMode = "shadow";
		const field = anchorField;
		const render = pendingRender;
		destroyIframeHost();
		if (field && render) {
			if (render.kind === "matches")
				buildDropdown(render.matches, field, { otpOnly: render.otpOnly });
			else buildLockedDropdown(field);
		}
	}, 700);
}

function iframeShow(field: HTMLInputElement, render: IframeRender): void {
	ensureIframeHost();
	if (!iframeHostEl) return;
	anchorField = field;
	positionHostElement(iframeHostEl, field);
	// Skip a redundant re-post when the same content is already showing here.
	const key = render.kind === "matches" ? matchesKey(render.matches) : "\0locked";
	if (iframeReady && key === iframeMatchesKey) return;
	iframeMatchesKey = key;
	pendingRender = render;
	if (iframeReady) flushPendingRender();
	else armReadinessTimeout();
}

/** Pick-time anti-clickjacking: reject a pick when the host is hidden, clipped, overlaid, or off-field. */
function pickIsTrustworthy(): boolean {
	if (!iframeHostEl) return false;
	const rect = iframeHostEl.getBoundingClientRect();
	if (rect.width < 60 || rect.height < 20) return false;
	if (
		rect.bottom <= 0 ||
		rect.right <= 0 ||
		rect.top >= window.innerHeight ||
		rect.left >= window.innerWidth
	) {
		return false;
	}
	const cs = getComputedStyle(iframeHostEl);
	if (cs.visibility !== "visible" || cs.display === "none") return false;
	if (Number.parseFloat(cs.opacity) < 0.9) return false;
	if (cs.filter !== "none" || cs.mixBlendMode !== "normal" || cs.clipPath !== "none") return false;
	// elementFromPoint resolves to the host (closed shadow); an unrelated element means an overlay.
	const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
	if (!top) return false;
	return top === iframeHostEl || iframeHostEl.contains(top) || top.contains(iframeHostEl);
}

// --- The visible host (shadow or iframe), positioning, and dismissal ---

/** The host element of whichever picker is currently *visible* (shadow or iframe). */
function activeHost(): HTMLElement | null {
	if (dropdownEl) return dropdownEl;
	if (iframeHostEl && iframeHostEl.style.display !== "none") return iframeHostEl;
	return null;
}

function repositionActive(): void {
	const host = activeHost();
	if (host && anchorField) positionHostElement(host, anchorField);
}

/** Dismiss whichever picker is showing (shadow dropdown or iframe). The iframe is hidden, not destroyed, so it can be reused without re-loading. */
function removeActiveUi(): void {
	removeDropdown();
	hideIframe();
}

// --- Renderer routing: iframe is primary, shadow is the COEP fallback. ---

function showMatchesUi(
	matches: MatchSummary[],
	field: HTMLInputElement,
	opts?: { otpOnly?: boolean },
): void {
	if (matches.length === 0) return;
	if (uiMode === "shadow") {
		buildDropdown(matches, field, opts);
		return;
	}
	iframeShow(field, { kind: "matches", matches, otpOnly: opts?.otpOnly === true });
}

function showLockedUi(field: HTMLInputElement): void {
	if (uiMode === "shadow") {
		buildLockedDropdown(field);
		return;
	}
	iframeShow(field, { kind: "locked" });
}

// Bridge from the iframe: honor only OUR iframe on the extension origin (a
// page-forged postMessage has a different source/origin and is dropped).
window.addEventListener("message", (e) => {
	if (!iframeEl || e.source !== iframeEl.contentWindow || e.origin !== EXT_ORIGIN) return;
	const msg = e.data as
		| { type: "AUTOFILL_UI_READY" }
		| { type: "UI_RESIZE"; height?: number }
		| { type: "UI_PICK"; entryId?: string; otpOnly?: boolean }
		| { type: "UI_POPOUT" }
		| { type: "UI_HIGHLIGHT"; active?: boolean }
		| undefined;
	switch (msg?.type) {
		case "AUTOFILL_UI_READY":
			iframeReady = true;
			uiMode = "iframe";
			if (readinessTimer !== null) {
				clearTimeout(readinessTimer);
				readinessTimer = null;
			}
			flushPendingRender();
			break;
		case "UI_RESIZE":
			if (iframeEl) {
				iframeEl.style.height = `${Math.max(0, Math.min(360, Number(msg.height) || 0))}px`;
			}
			break;
		case "UI_PICK":
			if (typeof msg.entryId === "string" && pickIsTrustworthy()) {
				pickCb?.(msg.entryId, !!msg.otpOnly);
			}
			break;
		case "UI_HIGHLIGHT":
			iframeHasHighlight = !!msg.active;
			break;
		case "UI_POPOUT":
			hideIframe();
			unlockCb?.();
			break;
	}
});

/** Arrow/Enter/Escape navigation for the open iframe dropdown; returns true if the key was consumed. */
function handleDropdownKey(e: KeyboardEvent): boolean {
	if (uiMode !== "iframe" || !iframeReady || !iframeHostEl) return false;
	if (iframeHostEl.style.display === "none") return false;
	if (document.activeElement !== anchorField) return false;
	const win = iframeEl?.contentWindow;
	if (!win) return false;
	if (e.key === "ArrowDown" || e.key === "ArrowUp") {
		e.preventDefault();
		win.postMessage({ type: "UI_KEY", key: e.key }, EXT_ORIGIN);
		return true;
	}
	if (e.key === "Escape") {
		e.preventDefault();
		dismissCb?.();
		hideIframe();
		return true;
	}
	// Enter only picks when a row is highlighted; otherwise the form submits normally.
	if (e.key === "Enter" && iframeHasHighlight) {
		e.preventDefault();
		win.postMessage({ type: "UI_KEY", key: "Enter" }, EXT_ORIGIN);
		return true;
	}
	return false;
}

// Tear both renderers down when the extension context is lost.
onTeardown(() => {
	removeDropdown();
	destroyIframeHost();
});

/** The autofill picker facade. Hides the iframe-vs-shadow split, the bridge, positioning, and keyboard nav. */
export const picker = {
	showMatches: showMatchesUi,
	showLocked: showLockedUi,
	reposition: repositionActive,
	remove: removeActiveUi,
	// Dismiss only the shadow-dropdown renderer (no-op in iframe mode); preserves
	// the original's removeDropdown-vs-removeActiveUi distinction at its call sites.
	removeDropdown,
	activeHost,
	clickIsOnAnchor,
	handleKey: handleDropdownKey,
	/** Fired with (entryId, otpOnly) when the user picks a match. */
	onPick(cb: (entryId: string, otpOnly: boolean) => void): void {
		pickCb = cb;
	},
	/** Fired when the user requests the unlock pop-out (locked row / iframe pop-out). */
	onUnlockRequest(cb: () => void): void {
		unlockCb = cb;
	},
	/** Fired when the user dismisses the picker via the keyboard (Escape). */
	onDismiss(cb: () => void): void {
		dismissCb = cb;
	},
};
