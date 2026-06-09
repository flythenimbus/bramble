/// <reference types="chrome" />

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
	const rect = field.getBoundingClientRect();
	dropdownEl.style.top = `${rect.bottom + window.scrollY + 2}px`;
	dropdownEl.style.left = `${rect.left + window.scrollX}px`;
	// One third of the field, floored at 240px for readability on narrow fields.
	const width = Math.max(rect.width / 3, 240);
	dropdownEl.style.width = `${width}px`;
}

/** Uppercase avatar initials: first letter of the first two words, else first two letters. */
function initials(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) return "??";
	const words = trimmed.split(/\s+/);
	if (words.length >= 2 && words[0] && words[1]) {
		return (words[0][0]! + words[1][0]!).toUpperCase();
	}
	return trimmed.slice(0, 2).toUpperCase();
}

// Stable colour per entry: same name always lands on the same swatch.
const AVATAR_COLORS = [
	"#7C3AED",
	"#2563EB",
	"#0891B2",
	"#059669",
	"#65A30D",
	"#CA8A04",
	"#EA580C",
	"#DC2626",
	"#DB2777",
];
function colorForName(name: string): string {
	let hash = 0;
	for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
	return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

function dropdownStyles(): string {
	return html`
		<style>
			#${DROPDOWN_ID} {
				background: rgba(28, 28, 30, 0.96);
				-webkit-backdrop-filter: saturate(180%) blur(20px);
				backdrop-filter: saturate(180%) blur(20px);
				border: 1px solid rgba(255, 255, 255, 0.06);
				border-radius: 14px;
				box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(0, 0, 0, 0.3);
				font-family:
					-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
				font-size: 13px;
				color: #fff;
				max-height: 320px;
				overflow-y: auto;
				padding: 4px;
				box-sizing: border-box;
			}
			#${DROPDOWN_ID} .tp-item {
				padding: 6px 8px;
				cursor: pointer !important;
				display: flex;
				align-items: center;
				gap: 12px;
				border-radius: 10px;
				transition: background 0.1s ease;
			}
			#${DROPDOWN_ID} .tp-item:hover {
				background: rgba(255, 255, 255, 0.08);
			}
			#${DROPDOWN_ID} .tp-locked {
				cursor: default;
			}
			#${DROPDOWN_ID} .tp-locked:hover {
				background: transparent;
			}
			#${DROPDOWN_ID} .tp-avatar {
				width: 40px;
				height: 40px;
				border-radius: 10px;
				display: flex;
				align-items: center;
				justify-content: center;
				font-size: 14px;
				font-weight: 600;
				color: #fff;
				flex-shrink: 0;
				letter-spacing: 0.5px;
			}
			#${DROPDOWN_ID} .tp-avatar-locked {
				background: rgba(255, 255, 255, 0.08);
				color: rgba(255, 255, 255, 0.6);
				font-size: 18px;
			}
			#${DROPDOWN_ID} .tp-text {
				display: flex;
				flex-direction: column;
				min-width: 0;
				flex: 1;
			}
			#${DROPDOWN_ID} .tp-name {
				font-weight: 600;
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
				color: #fff;
				line-height: 1.3;
			}
			#${DROPDOWN_ID} .tp-user {
				color: rgba(235, 235, 245, 0.55);
				font-size: 12px;
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
				margin-top: 2px;
				line-height: 1.3;
			}
		</style>
	`;
}

function mountDropdown(field: HTMLInputElement, bodyHtml: string): HTMLElement {
	removeDropdown();
	anchorField = field;

	const root = document.createElement("div");
	root.id = DROPDOWN_ID;
	// Inline so positioning doesn't depend on the inner stylesheet parsing first.
	root.style.cssText = "position: absolute; z-index: 2147483647;";
	root.innerHTML = dropdownStyles() + bodyHtml;

	dropdownEl = root;
	document.body.appendChild(dropdownEl);
	positionDropdown(field);
	return root;
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
		${matches.map(
			(m) => html`
				<div class="tp-item" data-entry-id="${m.id}">
					<div class="tp-avatar" style="background: ${colorForName(m.name)};">
						${initials(m.name)}
					</div>
					<div class="tp-text">
						<span class="tp-name">${m.name}</span>
						<span class="tp-user">${m.secondary}</span>
					</div>
				</div>
			`,
		)}
	`;
	const root = mountDropdown(field, body);
	openMatchesKey = key;
	openDropdownKind = "matches";

	// mousedown (not click) beats the field's blur; otherwise focus leaves first
	// and the click never reaches us.
	root.addEventListener("mousedown", (e) => {
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
	const body = html`
		<div class="tp-item tp-locked" data-tp-popout="1">
			<div class="tp-avatar tp-avatar-locked">🔒</div>
			<div class="tp-text">
				<span class="tp-name">Vault locked</span>
				<span class="tp-user">Click to unlock in a window</span>
			</div>
		</div>
	`;
	const root = mountDropdown(field, body);
	openDropdownKind = "locked";

	// mousedown beats the field's blur; otherwise the row never gets the click.
	root.addEventListener("mousedown", (e) => {
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
	removeDropdown();
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
		buildLockedDropdown(focused);
		return;
	}

	const kind = candidateKind(focused);
	if (kind === "card") {
		if (result.cards.length > 0) buildDropdown(result.cards, focused);
		return;
	}
	if (kind === "otp") {
		const otps = result.otps ?? [];
		if (otps.length > 0) buildDropdown(otps, focused, { otpOnly: true });
		return;
	}
	// login
	if (result.logins.length > 0) buildDropdown(result.logins, focused);
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
let currentPrompt: CornerPromptPayload | null = null;

function removeCornerPrompt(): void {
	if (cornerPromptEl) {
		cornerPromptEl.remove();
		cornerPromptEl = null;
	}
	currentPrompt = null;
}

function cornerStyles(): string {
	return html`
		<style>
			#${CORNER_ID} {
				background: rgba(28, 28, 30, 0.96);
				-webkit-backdrop-filter: saturate(180%) blur(20px);
				backdrop-filter: saturate(180%) blur(20px);
				border: 1px solid rgba(255, 255, 255, 0.08);
				border-radius: 14px;
				box-shadow:
					0 16px 48px rgba(0, 0, 0, 0.5),
					0 0 0 1px rgba(0, 0, 0, 0.3);
				font-family:
					-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
				font-size: 13px;
				color: #fff;
				padding: 20px;
				box-sizing: border-box;
				width: 360px;
			}
			#${CORNER_ID} .tp-head {
				display: flex;
				align-items: flex-start;
				justify-content: space-between;
				gap: 12px;
				margin-bottom: 18px;
			}
			#${CORNER_ID} .tp-title {
				font-weight: 600;
				font-size: 16px;
				line-height: 1.3;
			}
			#${CORNER_ID} .tp-host {
				color: rgba(235, 235, 245, 0.55);
				font-size: 12px;
				margin-top: 4px;
			}
			#${CORNER_ID} .tp-close {
				background: transparent;
				border: 0;
				color: rgba(235, 235, 245, 0.55);
				cursor: pointer;
				font-size: 18px;
				line-height: 1;
				padding: 2px 6px;
				border-radius: 6px;
			}
			#${CORNER_ID} .tp-close:hover {
				background: rgba(255, 255, 255, 0.06);
				color: #fff;
			}
			#${CORNER_ID} .tp-row {
				display: flex;
				flex-direction: column;
				gap: 7px;
				margin-bottom: 14px;
			}
			#${CORNER_ID} .tp-label {
				font-size: 11px;
				color: rgba(235, 235, 245, 0.55);
				text-transform: uppercase;
				letter-spacing: 0.5px;
				font-weight: 500;
			}
			#${CORNER_ID} input.tp-input {
				background: rgba(255, 255, 255, 0.06);
				border: 1px solid rgba(255, 255, 255, 0.1);
				border-radius: 8px;
				color: #fff;
				padding: 10px 12px;
				font: inherit;
				font-size: 13px;
				outline: none;
				width: 100%;
				box-sizing: border-box;
			}
			#${CORNER_ID} input.tp-input:focus {
				border-color: rgba(255, 255, 255, 0.4);
			}
			#${CORNER_ID} .tp-password-wrap {
				position: relative;
			}
			#${CORNER_ID} .tp-password-toggle {
				position: absolute;
				right: 6px;
				top: 50%;
				transform: translateY(-50%);
				background: transparent;
				border: 0;
				color: rgba(235, 235, 245, 0.55);
				cursor: pointer;
				font-size: 11px;
				padding: 6px 8px;
				border-radius: 6px;
			}
			#${CORNER_ID} .tp-password-toggle:hover {
				background: rgba(255, 255, 255, 0.08);
				color: #fff;
			}
			#${CORNER_ID} .tp-candidates {
				display: flex;
				flex-direction: column;
				gap: 8px;
				margin-bottom: 16px;
			}
			#${CORNER_ID} .tp-candidate {
				display: flex;
				align-items: center;
				gap: 12px;
				padding: 12px 14px;
				background: rgba(255, 255, 255, 0.04);
				border: 1px solid rgba(255, 255, 255, 0.08);
				border-radius: 10px;
				cursor: pointer;
			}
			#${CORNER_ID} .tp-candidate:hover {
				background: rgba(255, 255, 255, 0.08);
			}
			#${CORNER_ID} .tp-candidate input[type="radio"] {
				accent-color: #fff;
			}
			#${CORNER_ID} .tp-candidate .tp-cand-name {
				font-weight: 600;
				font-size: 13px;
			}
			#${CORNER_ID} .tp-candidate .tp-cand-user {
				color: rgba(235, 235, 245, 0.55);
				font-size: 12px;
				margin-top: 2px;
			}
			#${CORNER_ID} .tp-actions {
				display: flex;
				gap: 10px;
				align-items: center;
				margin-top: 18px;
				position: relative;
			}
			#${CORNER_ID} button.tp-btn {
				background: transparent;
				color: #fff;
				border: 1px solid rgba(255, 255, 255, 0.14);
				border-radius: 8px;
				padding: 10px 16px;
				font: inherit;
				font-size: 13px;
				font-weight: 500;
				cursor: pointer;
				transition:
					background 0.1s ease,
					border-color 0.1s ease;
			}
			#${CORNER_ID} .tp-btn:hover {
				background: rgba(255, 255, 255, 0.06);
				border-color: rgba(255, 255, 255, 0.24);
			}
			#${CORNER_ID} button.tp-btn-primary {
				background: #fafafa;
				color: #18181b;
				border: 1px solid rgba(255, 255, 255, 0.2);
			}
			#${CORNER_ID} button.tp-btn-primary:hover {
				background: #e4e4e7;
				border-color: rgba(255, 255, 255, 0.3);
			}
			#${CORNER_ID} .tp-overflow {
				margin-left: auto;
				background: transparent;
				border: 1px solid transparent;
				color: rgba(235, 235, 245, 0.55);
				cursor: pointer;
				font-size: 18px;
				padding: 6px 10px;
				border-radius: 8px;
				line-height: 1;
			}
			#${CORNER_ID} .tp-overflow:hover {
				background: rgba(255, 255, 255, 0.06);
				border-color: rgba(255, 255, 255, 0.14);
				color: #fff;
			}
			#${CORNER_ID} .tp-menu {
				position: absolute;
				right: 0;
				bottom: 52px;
				background: rgba(40, 40, 44, 0.98);
				border: 1px solid rgba(255, 255, 255, 0.1);
				border-radius: 10px;
				padding: 6px;
				box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
				z-index: 1;
				min-width: 160px;
			}
			#${CORNER_ID} .tp-menu button {
				background: transparent;
				color: #fff;
				border: 0;
				padding: 9px 12px;
				font: inherit;
				font-size: 13px;
				cursor: pointer;
				border-radius: 6px;
				width: 100%;
				text-align: left;
			}
			#${CORNER_ID} .tp-menu button:hover {
				background: rgba(255, 255, 255, 0.08);
			}
		</style>
	`;
}

/** Renders the "Save New Login" card body. */
function buildSaveLoginBody(p: Extract<CornerPromptPayload, { kind: "save-login" }>): string {
	const primaryLabel = p.locked ? "Unlock & Save" : "Save";
	const primaryAction = p.locked ? "save-unlock-first" : "save";
	return html`
		<div class="tp-head">
			<div>
				<div class="tp-title">Save New Login</div>
				<div class="tp-host">${p.hostname}</div>
			</div>
			<button class="tp-close" data-tp-action="dismiss" aria-label="Dismiss">×</button>
		</div>
		<div class="tp-row">
			<div class="tp-label">Username</div>
			<input class="tp-input" id="tp-username" type="text" value="${p.username}" autocomplete="off" />
		</div>
		<div class="tp-row">
			<div class="tp-label">Password</div>
			<div class="tp-password-wrap">
				<input class="tp-input" id="tp-password" type="password" value="${p.password}" autocomplete="off" readonly />
				<button class="tp-password-toggle" data-tp-action="toggle-password">Show</button>
			</div>
		</div>
		<div class="tp-actions">
			<button class="tp-btn tp-btn-primary" data-tp-action="${primaryAction}">${primaryLabel}</button>
			<button class="tp-btn" data-tp-action="dismiss">Not now</button>
			<button class="tp-overflow" data-tp-action="toggle-menu" aria-label="More">⋯</button>
		</div>
	`;
}

/** Renders the "Update login" card body; "Save as new" keeps existing entries instead of rotating. */
function buildUpdateLoginBody(p: Extract<CornerPromptPayload, { kind: "update-login" }>): string {
	const primaryLabel = p.locked ? "Unlock & Update" : "Update";
	const primaryAction = p.locked ? "save-unlock-first" : "update";
	// >1 candidate: ask which entry to update; exactly 1: confirm the rotation.
	const title = p.candidates.length > 1 ? "Update an existing login?" : "Update saved login?";
	const candidatesBody =
		p.candidates.length > 1
			? html`
					<div class="tp-candidates">
						${p.candidates.map(
							(c, i) => html`
								<label class="tp-candidate">
									<input type="radio" name="tp-update-target" value="${c.id}" ${i === 0 ? "checked" : ""} />
									<div>
										<div class="tp-cand-name">${c.name}</div>
										<div class="tp-cand-user">${c.username}</div>
									</div>
								</label>
							`,
						)}
					</div>
				`
			: html`
					<div class="tp-row">
						<div class="tp-label">Account</div>
						<div>${p.candidates[0]?.name ?? ""} <span style="color: rgba(235,235,245,0.55)">(${p.candidates[0]?.username ?? ""})</span></div>
						<input type="hidden" name="tp-update-target" value="${p.candidates[0]?.id ?? ""}" />
					</div>
				`;
	return html`
		<div class="tp-head">
			<div>
				<div class="tp-title">${title}</div>
				<div class="tp-host">${p.hostname}</div>
			</div>
			<button class="tp-close" data-tp-action="dismiss" aria-label="Dismiss">×</button>
		</div>
		${candidatesBody}
		<div class="tp-actions">
			<button class="tp-btn tp-btn-primary" data-tp-action="${primaryAction}">${primaryLabel}</button>
			<button class="tp-btn" data-tp-action="save-new" title="Save as a separate login instead of updating">Save as new</button>
			<button class="tp-overflow" data-tp-action="toggle-menu" aria-label="More">⋯</button>
		</div>
	`;
}

function sendCornerResponse(action: string, extra?: Record<string, unknown>): void {
	if (!currentPrompt) return;
	safeSendMessage({
		type: "CORNER_PROMPT_RESPONSE",
		payload: { promptId: currentPrompt.promptId, action, ...extra },
	});
}

function closeOverflowMenu(): void {
	cornerPromptEl?.querySelector(".tp-menu")?.remove();
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
	if (!actionEl || !cornerPromptEl?.contains(actionEl)) return;
	const action = actionEl.dataset.tpAction;
	if (!action || !currentPrompt) return;

	if (action === "toggle-password") {
		const pw = cornerPromptEl.querySelector<HTMLInputElement>("#tp-password");
		if (!pw) return;
		pw.type = pw.type === "password" ? "text" : "password";
		actionEl.textContent = pw.type === "password" ? "Show" : "Hide";
		return;
	}
	if (action === "toggle-menu") {
		const existing = cornerPromptEl.querySelector(".tp-menu");
		if (existing) {
			existing.remove();
			return;
		}
		const menu = document.createElement("div");
		menu.className = "tp-menu";
		menu.innerHTML = html`<button data-tp-action="never">Never for this site</button>`;
		const actions = cornerPromptEl.querySelector(".tp-actions");
		(actions ?? cornerPromptEl).appendChild(menu);
		return;
	}

	if (action === "save") {
		const usernameInput = cornerPromptEl.querySelector<HTMLInputElement>("#tp-username");
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
			cornerPromptEl.querySelector<HTMLInputElement>('input[name="tp-update-target"]:checked') ??
			cornerPromptEl.querySelector<HTMLInputElement>('input[name="tp-update-target"]');
		const chosenEntryId = radio?.value;
		if (!chosenEntryId) return;
		sendCornerResponse("update", { chosenEntryId });
		removeCornerPrompt();
		return;
	}
	if (action === "save-unlock-first") {
		// Pass chosenEntryId if picked: the locked-flow commit re-runs dedupe but
		// honors an explicit choice when present.
		const radio = cornerPromptEl.querySelector<HTMLInputElement>(
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
	const body =
		payload.kind === "save-login" ? buildSaveLoginBody(payload) : buildUpdateLoginBody(payload);
	root.innerHTML = cornerStyles() + body;
	root.addEventListener("click", handleCornerCardClick, true);

	cornerPromptEl = root;
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
		buildLockedDropdown(field);
		return;
	}
	if (candidateKind(field) === "card") {
		if (cachedResult.cards.length > 0) buildDropdown(cachedResult.cards, field);
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
			buildDropdown(otps, field, { otpOnly: true });
		}
		return;
	}
	if (cachedResult.logins.length === 0) {
		queryAutofill();
		return;
	}
	if (cachedResult.logins.length > 1 || !field.value) {
		buildDropdown(cachedResult.logins, field);
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
			if (dropdownEl) {
				const target = e.target;
				if (target instanceof Node) {
					if (dropdownEl.contains(target)) return;
					if (clickIsOnAnchor(target)) return;
				}
				silenceAutoOpen = true;
				removeDropdown();
				return;
			}
			// Dropdown closed: a mousedown on a candidate field is re-engagement.
			const target = e.target;
			if (isAutofillCandidate(target)) {
				silenceAutoOpen = false;
				// Re-click on the already-focused field fires no focusin, so show ourselves.
				if (document.activeElement === target) showFor(target);
			}
		},
		true,
	);
	window.addEventListener(
		"scroll",
		() => {
			if (dropdownEl && anchorField) {
				positionDropdown(anchorField);
			}
		},
		true,
	);
	window.addEventListener(
		"resize",
		() => {
			if (dropdownEl && anchorField) {
				positionDropdown(anchorField);
			}
		},
		true,
	);
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", bootstrap);
} else {
	bootstrap();
}
