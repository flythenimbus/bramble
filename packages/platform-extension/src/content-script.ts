/// <reference types="chrome" />

import {
	candidateKind,
	cardFieldsPresent,
	deriveMatcher,
	detectCardFields,
	detectLoginFields,
	findNewPasswordOnChangeForm,
	getFillableInputs,
	hasInteractiveCaptcha,
	isAutofillCandidate,
	matchesField,
	otpInputs,
} from "./detection";
import { cornerStyles } from "./html/corner-styles";
import { dropdownItem } from "./html/dropdown-item";
import { dropdownLocked } from "./html/dropdown-locked";
import { dropdownStyles } from "./html/dropdown-styles";
import { saveLoginBody } from "./html/save-login-body";
import { updateLoginBody } from "./html/update-login-body";

let extensionAlive = true;
let mutationObserver: MutationObserver | null = null;

/** False once the extension context is invalidated (orphaned content script); tears us down on first detection. */
function isExtensionAlive(): boolean {
	if (!extensionAlive) return false;
	if (!chrome.runtime?.id) {
		extensionAlive = false;
		teardown();
		return false;
	}
	return true;
}

function teardown(): void {
	mutationObserver?.disconnect();
	mutationObserver = null;
	removeDropdown();
	destroyIframeHost();
	removeCornerPrompt();
}

/** Sends a runtime message, swallowing the throw if the extension context is gone. */
function safeSendMessage(message: unknown): void {
	if (!isExtensionAlive()) return;
	try {
		chrome.runtime.sendMessage(message);
	} catch {
		extensionAlive = false;
		teardown();
	}
}

interface MatchSummary {
	id: string;
	name: string;
	// Username for a login, masked "•••• 1234" for a card.
	secondary: string;
	autofillEnabled?: boolean;
	autoSubmit?: boolean;
}

interface CustomFieldData {
	key: string;
	value: string;
}

interface QueryResult {
	// Logins matching this page's hostname.
	logins: MatchSummary[];
	// Every stored card (offered on any payment form).
	cards: MatchSummary[];
	// Hostname-matched logins with a TOTP key (offered on a one-time-code field).
	otps: MatchSummary[];
	locked: boolean;
	hasPotentialMatch: boolean;
}

/** Fill instruction from the background, discriminated by `kind`. `isAuto` echoes whether the fill was user-initiated. */
type FillPayload =
	| {
			kind: "login";
			username: string;
			password: string;
			// Live one-time code, present when the login has a TOTP key.
			totp?: string;
			customFields?: CustomFieldData[];
			autoSubmit?: boolean;
			isAuto?: boolean;
			// Fill only the page's one-time-code field (the 2FA step), not the
			// username/password.
			otpOnly?: boolean;
	  }
	| {
			kind: "card";
			cardholderName: string;
			number: string;
			expMonth: string;
			expYear: string;
			cvv: string;
			customFields?: CustomFieldData[];
			isAuto?: boolean;
	  };

// Mirror of `CornerPromptPayload` in `@core/adapters/autofill`; duplicated to
// keep the content script a flat bundle with no cross-package runtime imports.
type CornerPromptPayload =
	| {
			kind: "save-login";
			promptId: string;
			hostname: string;
			locked: boolean;
			username: string;
			password: string;
	  }
	| {
			kind: "update-login";
			promptId: string;
			hostname: string;
			locked: boolean;
			candidates: { id: string; name: string; username: string }[];
			newPassword: string;
	  };

/** Sets an input's value via the native setter so frameworks (React) observe the change. */
function setNativeValue(el: HTMLInputElement, value: string): void {
	const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
	desc?.set?.call(el, value);
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

function fillField(el: HTMLInputElement, value: string): void {
	setNativeValue(el, value);
	el.dispatchEvent(new Event("change", { bubbles: true }));
}

// Auto-fill skips these so clearing a field isn't re-clobbered by the next
// query. Explicit dropdown selection ignores this set and always fills.
const autoFilledFields = new WeakSet<HTMLInputElement>();

// Last password we autofilled; capture compares against it to suppress "save"
// prompts for unchanged autofilled credentials.
let lastFilledPassword: string | null = null;

/** Fills the page's login fields. When `isAuto`, skips fields already auto-filled this session. */
function fillForm(
	username: string,
	password: string,
	isAuto: boolean,
): {
	filled: boolean;
	passwordField: HTMLInputElement | null;
} {
	const { username: userField, password: pwField } = detectLoginFields();
	let filled = false;
	if (userField && !(isAuto && autoFilledFields.has(userField))) {
		fillField(userField, username);
		autoFilledFields.add(userField);
		filled = true;
	}
	if (pwField && !(isAuto && autoFilledFields.has(pwField))) {
		fillField(pwField, password);
		autoFilledFields.add(pwField);
		lastFilledPassword = password;
		filled = true;
	}
	return { filled, passwordField: pwField };
}

/**
 * Submits the form after autofill: prefers requestSubmit() on the enclosing
 * <form>, falling back to a synthesised Enter keypress for key-handler forms.
 */
function submitFromField(field: HTMLInputElement | null): void {
	if (!field) return;
	const form = field.closest("form");
	if (form && typeof form.requestSubmit === "function") {
		try {
			form.requestSubmit();
			return;
		} catch {
			// requestSubmit can throw if there's no submit button; fall through.
		}
	}
	const enter = new KeyboardEvent("keydown", {
		key: "Enter",
		code: "Enter",
		keyCode: 13,
		which: 13,
		bubbles: true,
		cancelable: true,
	});
	field.dispatchEvent(enter);
}

/** Inputs owned by built-in login/card autofill; custom fields never fill these, so they can't hijack a primary slot. */
function reservedInputs(): Set<HTMLInputElement> {
	const reserved = new Set<HTMLInputElement>();
	const login = detectLoginFields();
	if (login.username) reserved.add(login.username);
	if (login.password) reserved.add(login.password);
	const card = detectCardFields();
	for (const el of [
		card.number,
		card.name,
		card.expCombined,
		card.expMonth,
		card.expYear,
		card.cvv,
	]) {
		if (el) reserved.add(el);
	}
	for (const el of otpInputs()) reserved.add(el);
	return reserved;
}

/** Fills each custom field into the first empty page input whose hint matches its derived name. */
function fillCustomFields(fields: CustomFieldData[] | undefined): void {
	if (!fields || fields.length === 0) return;
	const reserved = reservedInputs();
	const inputs = getFillableInputs().filter((el) => !reserved.has(el));
	for (const field of fields) {
		if (!field.value) continue;
		const matcher = deriveMatcher(field.key);
		if (!matcher) continue;
		for (const el of inputs) {
			if (el.value || autoFilledFields.has(el)) continue;
			if (matchesField(el, matcher)) {
				fillField(el, field.value);
				autoFilledFields.add(el);
				break;
			}
		}
	}
}

function digits(value: string): string {
	return value.replace(/\D/g, "");
}

/** Renders the stored expiry year to suit the target field's width (2- vs 4-digit). */
function expYearFor(field: HTMLInputElement, year: string): string {
	const two = year.slice(-2);
	if (field.maxLength > 0 && field.maxLength <= 2) return two;
	return year.length <= 2 ? `20${two}` : year;
}

function fillCard(card: Extract<FillPayload, { kind: "card" }>): boolean {
	const c = detectCardFields();
	let filled = false;
	const put = (el: HTMLInputElement | null, value: string) => {
		if (!el || !value || autoFilledFields.has(el)) return;
		fillField(el, value);
		autoFilledFields.add(el);
		filled = true;
	};
	const mm = card.expMonth.padStart(2, "0");
	put(c.number, digits(card.number));
	put(c.name, card.cardholderName);
	if (c.expCombined) put(c.expCombined, `${mm}/${card.expYear.slice(-2)}`);
	put(c.expMonth, mm);
	if (c.expYear) put(c.expYear, expYearFor(c.expYear, card.expYear));
	put(c.cvv, card.cvv);
	return filled;
}

/** Fills the page's OTP field(s): whole code into a single field, one char per box for a segmented widget. */
function fillOtp(code: string | undefined): boolean {
	if (!code) return false;
	const fields = otpInputs();
	if (fields.length === 0) return false;
	if (fields.length === 1) {
		const el = fields[0]!;
		fillField(el, code);
		autoFilledFields.add(el);
		return true;
	}
	let filled = false;
	fields.forEach((el, i) => {
		const ch = code[i] ?? "";
		fillField(el, ch);
		autoFilledFields.add(el);
		if (ch) filled = true;
	});
	return filled;
}

const DROPDOWN_ID = "titanpass-autofill-dropdown";

let dropdownEl: HTMLElement | null = null;
// `null` until the first query response: distinguishes "unknown" from "queried,
// came back empty" (a locked default would flash "Vault locked" on every load).
let cachedResult: QueryResult | null = null;
let anchorField: HTMLInputElement | null = null;
// Joined ids of the rendered matches; lets re-queries with the same set skip
// the remove-and-re-add cycle that caused flicker on dynamic pages.
let openMatchesKey = "";
let openDropdownKind: "matches" | "locked" | null = null;
// Set when the user explicitly closes the popover; suppresses redisplay from
// re-queries until they re-engage (focus, type, or mousedown on a field).
let silenceAutoOpen = false;

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

function escapeHtml(value: unknown): string {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Tagged template that html-escapes scalar interpolations; arrays join verbatim so nested `html` results don't double-escape. */
function html(strings: TemplateStringsArray, ...values: unknown[]): string {
	let out = strings[0] ?? "";
	for (let i = 0; i < values.length; i++) {
		const v = values[i];
		out += Array.isArray(v) ? v.join("") : escapeHtml(v);
		out += strings[i + 1] ?? "";
	}
	return out;
}

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

// Iframe renderer (primary); the shadow path above is the COEP fallback. See docs/autofill.md.

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

/** Anchor a host element below `field`, matching the dropdown's geometry. */
function positionHostElement(el: HTMLElement, field: HTMLInputElement): void {
	const rect = field.getBoundingClientRect();
	el.style.top = `${rect.bottom + window.scrollY + 2}px`;
	el.style.left = `${rect.left + window.scrollX}px`;
	// One third of the field, floored at 240px for readability on narrow fields.
	el.style.width = `${Math.max(rect.width / 3, 240)}px`;
}

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
				selectMatch(msg.entryId, false, !!msg.otpOnly);
			}
			break;
		case "UI_HIGHLIGHT":
			iframeHasHighlight = !!msg.active;
			break;
		case "UI_POPOUT":
			hideIframe();
			safeSendMessage({ type: "POPOUT_OPEN" });
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
		silenceAutoOpen = true;
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
		if (id) selectMatch(id, false, opts?.otpOnly === true);
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
		safeSendMessage({ type: "POPOUT_OPEN" });
	});
}

/** Dismisses the dropdown and asks the background to fetch and fill the chosen entry. */
function selectMatch(entryId: string, isAuto: boolean, otpOnly = false): void {
	// Manual selection counts as an explicit dismissal; silence auto-redisplay
	// (e.g. a re-query landing mid-fill) until the user re-engages a field.
	if (!isAuto) silenceAutoOpen = true;
	removeActiveUi();
	safeSendMessage({
		type: "AUTOFILL_SELECT",
		payload: { entryId, hostname: location.hostname, isAuto, otpOnly },
	});
}

function focusedCandidate(): HTMLInputElement | null {
	const focused = document.activeElement;
	return focused instanceof HTMLInputElement && isAutofillCandidate(focused) ? focused : null;
}

function isQueryResult(v: unknown): v is QueryResult {
	return (
		typeof v === "object" &&
		v !== null &&
		Array.isArray((v as QueryResult).logins) &&
		Array.isArray((v as QueryResult).cards) &&
		typeof (v as QueryResult).locked === "boolean"
	);
}

/**
 * Caches the query result and surfaces the picker if a candidate field is focused.
 * SECURITY: never fills without an explicit user gesture; secrets are fetched only
 * on AUTOFILL_SELECT, so a password is never injected into the DOM on load.
 */
function handleResult(result: QueryResult | undefined): void {
	// Background forwards `undefined` when offscreen erred; keep the last good
	// cached result rather than clobbering it.
	if (!isQueryResult(result)) return;
	cachedResult = result;

	// User dismissed/selected: don't resurrect the dropdown from a re-query until
	// they re-engage. cachedResult is still updated so the next focus sees fresh data.
	if (silenceAutoOpen) return;

	const focused = focusedCandidate();
	if (!focused) return;

	if (result.locked) {
		showLockedUi(focused);
		return;
	}

	const kind = candidateKind(focused);
	if (kind === "card") {
		if (result.cards.length > 0) showMatchesUi(result.cards, focused);
		return;
	}
	if (kind === "otp") {
		const otps = result.otps ?? [];
		if (otps.length > 0) showMatchesUi(otps, focused, { otpOnly: true });
		return;
	}
	// login
	if (result.logins.length > 0) showMatchesUi(result.logins, focused);
}

/** Asks the background what's available for this page, but only if a fillable field exists. */
function queryAutofill(): void {
	const login = detectLoginFields();
	const hasLogin = !!(login.username || login.password);
	const hasCard = cardFieldsPresent(detectCardFields());
	const hasOtp = otpInputs().length > 0;
	if (!hasLogin && !hasCard && !hasOtp) return;

	safeSendMessage({
		type: "AUTOFILL_QUERY",
		hostname: location.hostname,
		hasLogin,
		hasCard,
		hasOtp,
	});
}

// Most recent user-typed password across all fields. Values we wrote via
// `fillForm` are not edits: gated on `e.isTrusted` below. Cleared on submit.
let lastUserEditedPassword: string | null = null;
let lastEditAt = 0;
// SPA submit fallback window: a password field vanishing within this many ms of
// the last edit is treated as a submit (React-removes-form, no native event).
const SPA_SUBMIT_WINDOW_MS = 1500;

/** Builds the capture payload from the current form state; returns null when any capture gate trips. */
function buildCapture(): { username: string; password: string } | null {
	if (lastUserEditedPassword === null) return null;
	// Don't fire a save prompt mid-CAPTCHA-challenge.
	if (hasInteractiveCaptcha()) return null;
	// OTP field present with no edited password: this submit is the 2FA confirm step.
	const login = detectLoginFields();
	if (otpInputs().length > 0 && !login.password) return null;

	const pwFields = document.querySelectorAll(
		'input[type="password"]:not([readonly]):not([disabled])',
	);
	let capturePassword = lastUserEditedPassword;
	if (pwFields.length >= 2) {
		// Change form (old/new/confirm): only capture when the new-password field
		// is confidently identified and its confirm matches.
		const newField = findNewPasswordOnChangeForm();
		if (!newField) return null;
		capturePassword = newField.value;
	}
	// Suppress unchanged autofilled credentials: nothing to save.
	if (capturePassword === lastFilledPassword) return null;

	const username =
		login.username?.value ??
		document.querySelector<HTMLInputElement>('input[autocomplete~="username"]')?.value ??
		"";
	return { username, password: capturePassword };
}

/** Emits a capture event to the background and clears state so re-submits don't duplicate it. */
function emitCapture(): void {
	const captured = buildCapture();
	if (!captured) return;
	if (!captured.password) return;
	safeSendMessage({
		type: "CORNER_PROMPT_CAPTURE",
		payload: { username: captured.username, password: captured.password },
	});
	lastUserEditedPassword = null;
}

// Track user-typed password edits. Only `e.isTrusted` events (real keystrokes,
// not our own `fillField` dispatches) count.
document.addEventListener(
	"input",
	(e) => {
		if (!e.isTrusted) return;
		const target = e.target;
		if (!(target instanceof HTMLInputElement)) return;
		if (target.type !== "password") return;
		lastUserEditedPassword = target.value;
		lastEditAt = Date.now();
	},
	true,
);

// Capture phase so we see the event before any handler that preventDefaults and
// rebuilds the DOM.
document.addEventListener(
	"submit",
	() => {
		emitCapture();
	},
	true,
);

// Enter inside a password field that drives no real `<form>` submit (lone
// inputs, ARIA pseudo-forms) is an effective submit; capture on it too.
document.addEventListener(
	"keydown",
	(e) => {
		if (!e.isTrusted) return;
		// Drive the open iframe dropdown with the keyboard first.
		if (handleDropdownKey(e)) return;
		if (e.key !== "Enter") return;
		const target = e.target;
		if (!(target instanceof HTMLInputElement)) return;
		if (target.type !== "password") return;
		// A real submit event may also fire; the duplicate emitCapture is harmless.
		emitCapture();
	},
	true,
);

/** Picks up a save/update prompt stashed by a prior page's submit (post-navigation capture). */
function queryCornerPrompt(): void {
	if (!isExtensionAlive()) return;
	try {
		chrome.runtime
			.sendMessage({ type: "CORNER_PROMPT_QUERY" })
			.then((resp: { ok: boolean; data?: CornerPromptPayload | null } | undefined) => {
				if (!resp?.ok || !resp.data) return;
				handleCornerPromptShow(resp.data);
			})
			.catch(() => {});
	} catch {
		extensionAlive = false;
		teardown();
	}
}

const CORNER_ID = "titanpass-corner-prompt";

let cornerPromptEl: HTMLElement | null = null;
// Closed shadow root of the corner prompt; in-card DOM queries go through this.
let cornerShadow: ShadowRoot | null = null;
let currentPrompt: CornerPromptPayload | null = null;

function removeCornerPrompt(): void {
	if (cornerPromptEl) {
		cornerPromptEl.remove();
		cornerPromptEl = null;
	}
	cornerShadow = null;
	currentPrompt = null;
}

/** Renders the "Save New Login" card body. */
function buildSaveLoginBody(p: Extract<CornerPromptPayload, { kind: "save-login" }>): string {
	const primaryLabel = p.locked ? "Unlock & Save" : "Save";
	const primaryAction = p.locked ? "save-unlock-first" : "save";
	const { username, password, hostname } = p;
	return saveLoginBody({
		username,
		password,
		hostname,
		primaryAction,
		primaryLabel,
	});
}

/** Renders the "Update login" card body; "Save as new" keeps existing entries instead of rotating. */
function buildUpdateLoginBody(p: Extract<CornerPromptPayload, { kind: "update-login" }>): string {
	const primaryLabel = p.locked ? "Unlock & Update" : "Update";
	const primaryAction = p.locked ? "save-unlock-first" : "update";
	// >1 candidate: ask which entry to update; exactly 1: confirm the rotation.
	const title = p.candidates.length > 1 ? "Update an existing login?" : "Update saved login?";
	return updateLoginBody({
		title,
		hostname: p.hostname,
		primaryAction,
		primaryLabel,
		candidates: p.candidates,
	});
}

function sendCornerResponse(action: string, extra?: Record<string, unknown>): void {
	if (!currentPrompt) return;
	safeSendMessage({
		type: "CORNER_PROMPT_RESPONSE",
		payload: { promptId: currentPrompt.promptId, action, ...extra },
	});
}

function closeOverflowMenu(): void {
	cornerShadow?.querySelector(".tp-menu")?.remove();
}

/** Delegated click handler for all action buttons inside the corner-prompt card. */
function handleCornerCardClick(e: Event): void {
	const target = e.target;
	if (!(target instanceof HTMLElement)) return;
	const actionEl = target.closest<HTMLElement>("[data-tp-action]");
	// Any click that isn't the overflow toggle or the menu itself closes an open menu.
	if (!actionEl || actionEl.dataset.tpAction !== "toggle-menu") {
		if (!target.closest(".tp-menu")) closeOverflowMenu();
	}
	if (!actionEl || !cornerShadow?.contains(actionEl)) return;
	const action = actionEl.dataset.tpAction;
	if (!action || !currentPrompt) return;

	if (action === "toggle-password") {
		const pw = cornerShadow.querySelector<HTMLInputElement>("#tp-password");
		if (!pw) return;
		pw.type = pw.type === "password" ? "text" : "password";
		actionEl.textContent = pw.type === "password" ? "Show" : "Hide";
		return;
	}
	if (action === "toggle-menu") {
		const existing = cornerShadow.querySelector(".tp-menu");
		if (existing) {
			existing.remove();
			return;
		}
		const menu = document.createElement("div");
		menu.className = "tp-menu";
		menu.innerHTML = html`<button data-tp-action="never">Never for this site</button>`;
		const actions = cornerShadow.querySelector(".tp-actions");
		(actions ?? cornerShadow).appendChild(menu);
		return;
	}

	if (action === "save") {
		const usernameInput = cornerShadow.querySelector<HTMLInputElement>("#tp-username");
		const edited = usernameInput?.value;
		sendCornerResponse("save", { editedUsername: edited });
		removeCornerPrompt();
		return;
	}
	if (action === "save-new") {
		// Keep existing entries, add captured credential as a separate login;
		// same backend path as a fresh save-login.
		sendCornerResponse("save");
		removeCornerPrompt();
		return;
	}
	if (action === "update") {
		const radio =
			cornerShadow.querySelector<HTMLInputElement>('input[name="tp-update-target"]:checked') ??
			cornerShadow.querySelector<HTMLInputElement>('input[name="tp-update-target"]');
		const chosenEntryId = radio?.value;
		if (!chosenEntryId) return;
		sendCornerResponse("update", { chosenEntryId });
		removeCornerPrompt();
		return;
	}
	if (action === "save-unlock-first") {
		// Pass chosenEntryId if picked: the locked-flow commit re-runs dedupe but
		// honors an explicit choice when present.
		const radio = cornerShadow.querySelector<HTMLInputElement>(
			'input[name="tp-update-target"]:checked',
		);
		sendCornerResponse("save-unlock-first", radio ? { chosenEntryId: radio.value } : undefined);
		removeCornerPrompt();
		return;
	}
	if (action === "dismiss") {
		sendCornerResponse("dismiss");
		removeCornerPrompt();
		return;
	}
	if (action === "never") {
		sendCornerResponse("never");
		removeCornerPrompt();
		return;
	}
}

// Clicking outside the card closes the overflow menu but keeps the card (so the
// captured credential isn't lost).
document.addEventListener(
	"mousedown",
	(e) => {
		if (!cornerPromptEl) return;
		const target = e.target;
		if (!(target instanceof Node)) return;
		if (!cornerPromptEl.contains(target)) closeOverflowMenu();
	},
	true,
);

/** Mounts the save/update corner prompt in the top-right of the page. */
function handleCornerPromptShow(payload: CornerPromptPayload): void {
	removeCornerPrompt();
	currentPrompt = payload;

	const root = document.createElement("div");
	root.id = CORNER_ID;
	// Inline so we don't depend on the inner stylesheet loading first.
	root.style.cssText = "position: fixed; top: 16px; right: 16px; z-index: 2147483647;";
	// Closed shadow root: keeps the captured credential out of page-readable DOM.
	const shadow = root.attachShadow({ mode: "closed" });
	const body =
		payload.kind === "save-login" ? buildSaveLoginBody(payload) : buildUpdateLoginBody(payload);
	shadow.innerHTML = cornerStyles + body;
	shadow.addEventListener("click", handleCornerCardClick, true);

	cornerPromptEl = root;
	cornerShadow = shadow;
	document.body.appendChild(root);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message?.type === "AUTOFILL_MATCHES") {
		handleResult(message.payload as QueryResult | undefined);
		sendResponse({ ok: true });
		return false;
	}

	if (message?.type === "CORNER_PROMPT_SHOW") {
		handleCornerPromptShow(message.payload as CornerPromptPayload);
		sendResponse({ ok: true });
		return false;
	}

	if (message?.type === "AUTOFILL_FILL") {
		const payload = message.payload as FillPayload;
		removeDropdown();
		if (payload.kind === "card") {
			const filled = fillCard(payload);
			fillCustomFields(payload.customFields);
			sendResponse({ ok: filled });
			return false;
		}
		// 2FA step: fill only the one-time-code field, nothing else.
		if (payload.otpOnly) {
			sendResponse({ ok: fillOtp(payload.totp) });
			return false;
		}
		const { filled, passwordField } = fillForm(
			payload.username,
			payload.password,
			!!payload.isAuto,
		);
		fillCustomFields(payload.customFields);
		// Combined login+2FA form: an explicit login pick also fills the OTP
		// field. No-op when the page has no OTP field.
		fillOtp(payload.totp);
		if (filled && payload.autoSubmit) {
			// Defer one tick so framework state (React controlled inputs) settles
			// before submit handlers read field values. Re-check for a late-rendered
			// captcha and skip submit if present (the user must solve it).
			setTimeout(() => {
				if (hasInteractiveCaptcha()) return;
				submitFromField(passwordField);
			}, 50);
		}
		sendResponse({ ok: filled });
		return false;
	}

	return false;
});

let lastCheck = 0;
/** MutationObserver callback: SPA-submit fallback plus a throttled autofill re-query. */
function onDomChange(): void {
	// SPA submit fallback: a password the user just edited whose field has now
	// vanished within the submit window is treated as a submit.
	if (
		lastUserEditedPassword !== null &&
		Date.now() - lastEditAt < SPA_SUBMIT_WINDOW_MS &&
		!document.querySelector('input[type="password"]:not([readonly]):not([disabled])')
	) {
		emitCapture();
	}
	const now = Date.now();
	if (now - lastCheck < 500) return;
	lastCheck = now;
	queryAutofill();
}

/** Decides what (if anything) to show when the user focuses or edits `field`, based on the cached result. */
function showFor(field: HTMLInputElement): void {
	if (silenceAutoOpen) return;
	if (!cachedResult) {
		// Focus before bootstrap's query returned: kick one off; handleResult
		// surfaces the dropdown if the field is still focused on response.
		queryAutofill();
		return;
	}
	if (cachedResult.locked) {
		showLockedUi(field);
		return;
	}
	if (candidateKind(field) === "card") {
		if (cachedResult.cards.length > 0) showMatchesUi(cachedResult.cards, field);
		else queryAutofill();
		return;
	}
	if (candidateKind(field) === "otp") {
		const otps = cachedResult.otps ?? [];
		if (otps.length === 0) {
			queryAutofill();
		} else if (otps.length > 1 || !field.value) {
			// A single match auto-fills on load; only re-offer the picker on a
			// choice or an empty field.
			showMatchesUi(otps, field, { otpOnly: true });
		}
		return;
	}
	if (cachedResult.logins.length === 0) {
		queryAutofill();
		return;
	}
	if (cachedResult.logins.length > 1 || !field.value) {
		showMatchesUi(cachedResult.logins, field);
	}
}

/** Runs initial queries and wires up the focus/input/mousedown/scroll listeners that drive the dropdown. */
function bootstrap(): void {
	queryAutofill();
	queryCornerPrompt();

	mutationObserver = new MutationObserver(() => onDomChange());
	mutationObserver.observe(document.body, { childList: true, subtree: true });

	// Show on focus; this makes the email-only first step (e.g. ikea.com) work.
	document.addEventListener(
		"focusin",
		(e) => {
			if (!isAutofillCandidate(e.target)) return;
			// Explicit focus re-arms auto-display after any prior silence.
			silenceAutoOpen = false;
			showFor(e.target);
		},
		true,
	);

	// Surface/dismiss as the user types in an already-focused field (focusin
	// doesn't fire then).
	document.addEventListener(
		"input",
		(e) => {
			// fillForm dispatches synthetic input/change events; reacting would
			// reopen the dropdown the user just dismissed. Only trust real events.
			if (!e.isTrusted) return;
			if (!isAutofillCandidate(e.target)) return;
			silenceAutoOpen = false;
			if (!cachedResult) {
				queryAutofill();
				return;
			}
			if (e.target.value && !cachedResult.locked) {
				// User is typing their own value: get out of the way unless there are
				// multiple matches of this field's kind to disambiguate.
				const kind = candidateKind(e.target);
				const count =
					kind === "card"
						? cachedResult.cards.length
						: kind === "otp"
							? (cachedResult.otps ?? []).length
							: cachedResult.logins.length;
				if (count <= 1) {
					removeDropdown();
					return;
				}
			}
			showFor(e.target);
		},
		true,
	);

	// mousedown (not click): it fires before focusin, so a mousedown on a
	// `<label>` doesn't race us into an "open + immediate close" flash, and the
	// same listener detects re-engagement when the dropdown is closed.
	document.addEventListener(
		"mousedown",
		(e) => {
			const host = activeHost();
			if (host) {
				const target = e.target;
				if (target instanceof Node) {
					// Clicks inside a cross-origin iframe never reach here.
					if (host.contains(target)) return;
					if (clickIsOnAnchor(target)) return;
				}
				silenceAutoOpen = true;
				removeActiveUi();
				return;
			}
			// Picker closed: a mousedown on a candidate field is re-engagement.
			const target = e.target;
			if (isAutofillCandidate(target)) {
				silenceAutoOpen = false;
				// Re-click on the already-focused field fires no focusin, so show ourselves.
				if (document.activeElement === target) showFor(target);
			}
		},
		true,
	);
	window.addEventListener("scroll", () => repositionActive(), true);
	window.addEventListener("resize", () => repositionActive(), true);
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", bootstrap);
} else {
	bootstrap();
}
