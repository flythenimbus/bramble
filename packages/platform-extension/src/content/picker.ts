/// <reference types="chrome" />

import { api } from "./content-api";
import { dropdownItem } from "./html/dropdown-item";
import { dropdownLocked } from "./html/dropdown-locked";
import { dropdownStyles } from "./html/dropdown-styles";
import { dropdownSuggest } from "./html/dropdown-suggest";
import { onTeardown } from "./lifecycle";
import type { MatchSummary } from "./types";

// The autofill picker: an extension-origin iframe (primary) with a closed-shadow
// dropdown as the COEP fallback. This module hides the iframe-vs-shadow decision,
// the postMessage bridge + origin checks, the clickjacking guard, positioning,
// and keyboard nav behind the `picker` facade at the bottom.

// User actions are reported via callbacks so this module never messages the
// background or touches the page's display policy directly.
let pickCb: ((entryId: string, otpOnly: boolean) => void) | null = null;
// Reports the field the unlock was requested from: clicking the locked row dismisses the picker,
// so the content policy needs the anchor to re-surface matches on it once the vault unlocks.
let unlockCb: ((field: HTMLInputElement | null) => void) | null = null;
let dismissCb: (() => void) | null = null;
// The generated-password suggestion row reports through its own callbacks so the
// content policy owns generation and the fill (this module never touches secrets).
let onSuggestedCb: (() => void) | null = null;
let regenerateCb: (() => void) | null = null;

// A suggest option threads a generated password to whichever renderer is active.
type SuggestOpt = { password: string };

/** Cache key for a rendered match set plus its optional suggest row. */
function renderKey(matches: MatchSummary[], suggest?: SuggestOpt): string {
	return (suggest ? `s:${suggest.password}\0` : "") + matchesKey(matches);
}

// Anchor field shared by both renderers (the page input the picker sits under).
let anchorField: HTMLInputElement | null = null;

// The field whose native autocomplete we overrode while taking it over, plus its original
// value, so we can put it back when we let go.
let suppressedField: HTMLInputElement | null = null;
let suppressedAutocomplete: string | null = null;

// A token we would blind ourselves by overwriting: `one-time-code` is the strongest rung of
// OTP detection, and on a segmented widget it is often the ONLY thing marking the boxes (see
// docs/field-detection.md). Writing over it on the anchor field takes that field out of the
// model at the next re-parse, and the user's pick is then refused as landing on nothing:
// which is what a real 2FA form did, with the dropdown opening and clicking it doing nothing.
const LOAD_BEARING_TOKEN_RE = /\bone-time-code\b/i;

// Route every anchorField change through here so the browser's native autofill is
// suppressed on exactly the field Bramble is handling and restored the moment we release
// it - otherwise the native dropdown renders on top of ours. The MutationObserver watches
// childList/subtree only (not attributes), so this write never invalidates the field-model
// cache directly; our own host insertion does, and the re-parse that follows reads whatever
// is on the field then. Best-effort: autocomplete="off" reliably suppresses Firefox and
// generic Chrome autofill; Chrome's own password UI on a recognized login field may persist.
function setAnchorField(field: HTMLInputElement | null): void {
	anchorField = field;
	if (suppressedField && suppressedField !== field) {
		if (suppressedAutocomplete === null) suppressedField.removeAttribute("autocomplete");
		else suppressedField.setAttribute("autocomplete", suppressedAutocomplete);
		suppressedField = null;
		suppressedAutocomplete = null;
	}
	if (field && field !== suppressedField) {
		const declared = field.getAttribute("autocomplete");
		// Nothing to gain and everything to lose: a browser has no stored one-time code to
		// offer on a desktop, so there is no native dropdown here to get out of the way of.
		if (declared && LOAD_BEARING_TOKEN_RE.test(declared)) return;
		suppressedField = field;
		suppressedAutocomplete = declared;
		field.setAttribute("autocomplete", "off");
	}
}

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

/** Match the field width for a bold, integrated look; floored so it stays substantial
 *  on narrow fields and capped so very wide fields don't sprawl. */
function pickerWidth(fieldWidth: number): number {
	return Math.min(Math.max(fieldWidth, 300), 440);
}

/** Anchor a host below `field` via a compositor-friendly transform (no layout). */
function positionHostElement(el: HTMLElement, field: HTMLInputElement): void {
	const rect = field.getBoundingClientRect();
	const x = rect.left + window.scrollX;
	const y = rect.bottom + window.scrollY + 2;
	const width = `${pickerWidth(rect.width)}px`;
	// translate (compositor-only) instead of top/left (layout) so the per-frame
	// tracker doesn't thrash layout; write only on change.
	const transform = `translate3d(${x}px, ${y}px, 0)`;
	if (el.style.transform !== transform) el.style.transform = transform;
	if (el.style.width !== width) el.style.width = width;
}

// Per-frame position tracking while a picker is visible. window 'scroll' is
// composed:false and doesn't bubble, so it never fires for scrolls inside a
// shadow root or a nested modal scroller (e.g. Reddit's login modal). The rAF
// loop keeps the picker pinned; transform writes keep the common case smooth.
let trackingRaf: number | null = null;
let lastX = Number.NaN;
let lastY = Number.NaN;
let lastWidth = Number.NaN;
let lastAnchor: HTMLInputElement | null = null;
// Hidden mid-scroll: JS tracking trails the compositor inside a modal/shadow
// scroller, so we hide while the field moves and snap back once it settles.
let scrollHidden = false;
let lastMoveTs = 0;
const SCROLL_SETTLE_MS = 120;

function startPositionTracking(): void {
	if (trackingRaf !== null) return;
	// Fresh loop: clear the baseline so the first frame doesn't read as a scroll.
	lastX = Number.NaN;
	lastAnchor = null;
	scrollHidden = false;
	const tick = (ts: number): void => {
		const host = activeHost();
		if (!host || !anchorField) {
			trackingRaf = null;
			return;
		}
		const rect = anchorField.getBoundingClientRect();
		const x = rect.left + window.scrollX;
		const y = rect.bottom + window.scrollY + 2;
		const width = pickerWidth(rect.width);
		// New field or first frame: re-baseline without treating it as a scroll.
		const rebaseline = Number.isNaN(lastX) || anchorField !== lastAnchor;
		const moved = !rebaseline && (x !== lastX || y !== lastY || width !== lastWidth);

		if (rebaseline || moved) {
			host.style.transform = `translate3d(${x}px, ${y}px, 0)`;
			host.style.width = `${width}px`;
		}
		lastX = x;
		lastY = y;
		lastWidth = width;
		lastAnchor = anchorField;

		// A change in the field's *document* position is an internal/modal scroll
		// (a window scroll leaves document coords constant, so the picker rides
		// along natively). Hide while it moves; snap back once settled.
		if (moved) {
			lastMoveTs = ts;
			if (!scrollHidden) {
				host.style.visibility = "hidden";
				scrollHidden = true;
			}
		} else if (scrollHidden && (rebaseline || ts - lastMoveTs >= SCROLL_SETTLE_MS)) {
			host.style.visibility = "";
			scrollHidden = false;
		}
		trackingRaf = requestAnimationFrame(tick);
	};
	trackingRaf = requestAnimationFrame(tick);
}

function stopPositionTracking(): void {
	if (trackingRaf !== null) {
		cancelAnimationFrame(trackingRaf);
		trackingRaf = null;
	}
	scrollHidden = false;
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
	setAnchorField(null);
	openMatchesKey = "";
	openDropdownKind = null;
}

function positionDropdown(field: HTMLInputElement): void {
	if (!dropdownEl) return;
	positionHostElement(dropdownEl, field);
}

function mountDropdown(field: HTMLInputElement, bodyHtml: string): ShadowRoot {
	removeDropdown();
	setAnchorField(field);

	const root = document.createElement("div");
	root.id = DROPDOWN_ID;
	// Inline so positioning doesn't depend on the inner stylesheet parsing first.
	root.style.cssText = "position: absolute; top: 0; left: 0; z-index: 2147483647;";
	// Closed: page gets `root.shadowRoot === null`. Listener attaches to the returned shadow.
	const shadow = root.attachShadow({ mode: "closed" });
	// Box styling lives on the inner .tp-dropdown (not :host) so the host page's
	// CSS reset can't reach it across the shadow boundary.
	shadow.innerHTML = `${dropdownStyles}<div class="tp-dropdown">${bodyHtml}</div>`;

	dropdownEl = root;
	document.body.appendChild(dropdownEl);
	positionDropdown(field);
	startPositionTracking();
	return shadow;
}

/** Renders the match picker anchored to `field`; no-op when content is unchanged to avoid flicker. */
function buildDropdown(
	matches: MatchSummary[],
	field: HTMLInputElement,
	opts?: { otpOnly?: boolean; suggest?: SuggestOpt },
): void {
	if (matches.length === 0 && !opts?.suggest) return;

	const key = renderKey(matches, opts?.suggest);
	// Same content/field already showing: keep the existing dropdown to avoid
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

	// Suggest row (if any) leads, then the matches. Join verbatim (each piece is
	// already escaped html) rather than interpolating strings, which would re-escape.
	const parts: string[] = [];
	if (opts?.suggest) parts.push(dropdownSuggest(opts.suggest.password));
	for (const m of matches) parts.push(dropdownItem({ ...m }));
	const root = mountDropdown(field, parts.join(""));
	openMatchesKey = key;
	openDropdownKind = "matches";

	// mousedown (not click) beats the field's blur; otherwise focus leaves first
	// and the click never reaches us.
	root.addEventListener("mousedown", (e) => {
		// Only a real user mousedown may act (no synthetic events).
		if (!e.isTrusted) return;
		const target = e.target as HTMLElement | null;
		// Regenerate sits inside the suggest row, so match it before data-tp-suggest.
		if (target?.closest("[data-tp-regenerate]")) {
			e.preventDefault();
			regenerateCb?.();
			return;
		}
		const item = target?.closest<HTMLElement>("[data-entry-id]");
		if (item?.dataset.entryId) {
			e.preventDefault();
			pickCb?.(item.dataset.entryId, opts?.otpOnly === true);
			return;
		}
		if (target?.closest("[data-tp-suggest]")) {
			e.preventDefault();
			onSuggestedCb?.();
		}
	});
}

function buildLockedDropdown(field: HTMLInputElement): void {
	if (dropdownEl && anchorField === field && openDropdownKind === "locked") {
		positionDropdown(field);
		return;
	}
	const root = mountDropdown(field, dropdownLocked());
	openDropdownKind = "locked";

	// mousedown beats the field's blur; otherwise the row never gets the click.
	root.addEventListener("mousedown", (e) => {
		// Only a genuine user click opens the pop-out.
		if (!e.isTrusted) return;
		const item = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-tp-popout]");
		if (!item) return;
		e.preventDefault();
		// Capture the anchor before removeDropdown() clears it, so the caller can re-surface here.
		const field = anchorField;
		removeDropdown();
		unlockCb?.(field);
	});
}

// --- Iframe renderer (primary); the shadow path above is the COEP fallback. ---

const AUTOFILL_UI_URL = api.runtime.getURL("autofill-ui.html");
// The extension url scheme (chrome-extension: / moz-extension:), the one thing about the iframe's
// origin we can know up front.
const EXT_SCHEME = new URL(AUTOFILL_UI_URL).protocol;
// The origin the iframe actually speaks from, adopted at its READY handshake. It is NOT always the
// origin of the url we set as src: under Chromium's manifest `use_dynamic_url`, getURL hands a
// content script a per-session GUID origin while the document it loads reports the extension's
// static one. Pinning posts (and inbound checks) to the src origin silently dropped every message
// in both directions, so READY never landed and the picker fell back to its shadow renderer on
// every page. Null until the handshake; every post is pinned to it, never "*".
let uiOrigin: string | null = null;

type IframeRender =
	| { kind: "matches"; matches: MatchSummary[]; otpOnly: boolean; suggest?: SuggestOpt }
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
	setAnchorField(null);
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
	uiOrigin = null; // a fresh frame re-introduces itself
	pendingRender = null;
	iframeMatchesKey = "";
	iframeHasHighlight = false;
	setAnchorField(null);
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
	host.style.cssText =
		"position: absolute; top: 0; left: 0; z-index: 2147483647; margin: 0; padding: 0; border: 0;";
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

/** Post to the iframe, pinned to the origin it introduced itself with. No-op before the handshake. */
function postToUi(message: unknown): void {
	const win = iframeEl?.contentWindow;
	if (!win || uiOrigin === null) return;
	win.postMessage(message, uiOrigin);
}

function flushPendingRender(): void {
	if (!iframeEl?.contentWindow || !pendingRender) return;
	const render = pendingRender;
	pendingRender = null;
	if (render.kind === "matches") {
		postToUi({
			type: "RENDER_MATCHES",
			matches: render.matches,
			otpOnly: render.otpOnly,
			suggest: render.suggest,
		});
	} else {
		postToUi({ type: "RENDER_LOCKED" });
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
	setAnchorField(field);
	positionHostElement(iframeHostEl, field);
	startPositionTracking();
	// Skip a redundant re-post when the same content is already showing here.
	const key = render.kind === "matches" ? renderKey(render.matches, render.suggest) : "\0locked";
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
	opts?: { otpOnly?: boolean; suggest?: SuggestOpt },
): void {
	if (matches.length === 0 && !opts?.suggest) return;
	if (uiMode === "shadow") {
		buildDropdown(matches, field, opts);
		return;
	}
	iframeShow(field, {
		kind: "matches",
		matches,
		otpOnly: opts?.otpOnly === true,
		suggest: opts?.suggest,
	});
}

function showLockedUi(field: HTMLInputElement): void {
	if (uiMode === "shadow") {
		buildLockedDropdown(field);
		return;
	}
	iframeShow(field, { kind: "locked" });
}

// Bridge from the iframe: honor only OUR iframe's window on an extension origin (a page-forged
// postMessage has a different source, and a frame navigated off the extension a different scheme).
window.addEventListener("message", (e) => {
	if (!iframeEl || e.source !== iframeEl.contentWindow) return;
	// The handshake introduces the frame's origin; everything after must match it exactly.
	if (uiOrigin === null) {
		if ((e.data as { type?: string } | undefined)?.type !== "AUTOFILL_UI_READY") return;
		if (!e.origin.startsWith(`${EXT_SCHEME}//`)) return;
		uiOrigin = e.origin;
	} else if (e.origin !== uiOrigin) {
		return;
	}
	const msg = e.data as
		| { type: "AUTOFILL_UI_READY" }
		| { type: "UI_RESIZE"; height?: number }
		| { type: "UI_PICK"; entryId?: string; otpOnly?: boolean }
		| { type: "UI_POPOUT" }
		| { type: "UI_HIGHLIGHT"; active?: boolean }
		| { type: "UI_USE_SUGGESTED" }
		| { type: "UI_REGENERATE" }
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
				iframeEl.style.height = `${Math.max(0, Math.min(400, Number(msg.height) || 0))}px`;
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
		case "UI_POPOUT": {
			// Capture the anchor before hideIframe() clears it, so the caller can re-surface here.
			const field = anchorField;
			hideIframe();
			unlockCb?.(field);
			break;
		}
		case "UI_USE_SUGGESTED":
			// Using the suggestion fills the page field, so it needs the same
			// anti-clickjacking gate as a secret pick.
			if (pickIsTrustworthy()) onSuggestedCb?.();
			break;
		case "UI_REGENERATE":
			regenerateCb?.();
			break;
	}
});

/** Arrow/Enter/Escape navigation for the open iframe dropdown; returns true if the key was consumed. */
function handleDropdownKey(e: KeyboardEvent): boolean {
	if (uiMode !== "iframe" || !iframeReady || !iframeHostEl) return false;
	if (iframeHostEl.style.display === "none") return false;
	if (document.activeElement !== anchorField) return false;
	if (!iframeEl?.contentWindow) return false;
	if (e.key === "ArrowDown" || e.key === "ArrowUp") {
		e.preventDefault();
		postToUi({ type: "UI_KEY", key: e.key });
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
		postToUi({ type: "UI_KEY", key: "Enter" });
		return true;
	}
	return false;
}

// Tear both renderers down when the extension context is lost.
onTeardown(() => {
	stopPositionTracking();
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
	/** The page field the visible picker is anchored to (the field its row belongs to). */
	anchorField: () => anchorField,
	clickIsOnAnchor,
	handleKey: handleDropdownKey,
	/** Fired with (entryId, otpOnly) when the user picks a match. */
	onPick(cb: (entryId: string, otpOnly: boolean) => void): void {
		pickCb = cb;
	},
	/** Fired when the user requests the unlock pop-out (locked row / iframe pop-out). */
	onUnlockRequest(cb: (field: HTMLInputElement | null) => void): void {
		unlockCb = cb;
	},
	/** Fired when the user dismisses the picker via the keyboard (Escape). */
	onDismiss(cb: () => void): void {
		dismissCb = cb;
	},
	/** Fired when the user chooses the generated-password suggestion row. */
	onUseSuggested(cb: () => void): void {
		onSuggestedCb = cb;
	},
	/** Fired when the user clicks the regenerate button on the suggestion row. */
	onRegenerate(cb: () => void): void {
		regenerateCb = cb;
	},
};
