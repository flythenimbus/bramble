/// <reference types="chrome" />

// Content-script entry: bootstraps autofill and wires DOM events to the picker,
// capture, fill, and corner-prompt modules. Holds the page-level display policy
// (the cached query result and the auto-open silence flag); the picker reports
// user actions back through callbacks.

import { maybeEmitSpaSubmit, onPasswordEnter } from "./capture";
import { api } from "./content-api";
import { handleCornerPromptShow, queryCornerPrompt } from "./corner-prompt";
import {
	cardFieldsPresent,
	composedTarget,
	deepActiveElement,
	hasInteractiveCaptcha,
	isCandidate,
	kindOf,
} from "./detection";
import { getPageFields, invalidatePageFields } from "./field-model";
import {
	fillCard,
	fillCustomFields,
	fillForm,
	fillOtp,
	fillPasswordFields,
	submitFromField,
} from "./fill";
import { onTeardown, safeSendMessage } from "./lifecycle";
import { generatePassword } from "./password-gen";
import { picker } from "./picker";
import { isPasswordChangeForm, shouldSuggestPassword, signupPasswordFields } from "./signup-detect";
import type { CornerPromptPayload, FillPayload, MatchSummary, QueryResult } from "./types";

let mutationObserver: MutationObserver | null = null;

// `null` until the first query response: distinguishes "unknown" from "queried,
// came back empty" (a locked default would flash "Vault locked" on every load).
let cachedResult: QueryResult | null = null;
// Set when the user explicitly closes the popover; suppresses redisplay from
// re-queries until they re-engage (focus, type, or mousedown on a field).
let silenceAutoOpen = false;
// Field to re-surface on the next query response even if it isn't focused. Set when the vault
// unlocks while a "Vault locked" picker is open: unlocking via the toolbar/pop-out moves focus
// off the page, so focusedCandidate() is null. See issue #20.
let reshowField: HTMLInputElement | null = null;
let lastCheck = 0;

// The generated password offered on a given field, cached so re-renders don't
// churn a new one each frame. Regenerate replaces it; the WeakMap forgets fields
// that leave the DOM.
const suggestionFor = new WeakMap<HTMLInputElement, string>();

/**
 * A generated-password suggestion for `field`, or null when this isn't an
 * account-creation flow. Generates once per field and caches it.
 */
function maybeSuggest(
	field: HTMLInputElement,
	hasExistingLogins: boolean,
): { password: string } | null {
	// Never suggest into a non-password field or one the user has already typed into.
	if (field.type !== "password" || field.value) return null;
	// The decision is cached per field and reused across re-renders. Re-evaluating would be both
	// wasteful and wrong: once the picker shows here it rewrites the anchor field's `autocomplete`
	// to "off" to suppress native autofill, which erases the new-password token the detector reads,
	// so a re-query (e.g. a saved login arriving) would flip us to showing the match. Deciding once,
	// while the attributes are still pristine, keeps the suggestion stable.
	const cached = suggestionFor.get(field);
	if (cached) return { password: cached };
	if (!shouldSuggestPassword(field, { hasExistingLogins })) return null;
	const pw = generatePassword();
	suggestionFor.set(field, pw);
	return { password: pw };
}

/** Shows the login picker for `field`: existing matches, or ONLY the strong-password row on a signup/rotation form. */
function showLoginPicker(field: HTMLInputElement, logins: MatchSummary[]): void {
	const suggest = maybeSuggest(field, logins.length > 0);
	// On an account-creation / password-rotation form, offer only the suggestion. Existing logins
	// aren't useful when making or rotating a credential and would clutter the prompt.
	if (suggest) {
		picker.showMatches([], field, { suggest });
		return;
	}
	if (logins.length === 0) return;
	picker.showMatches(logins, field);
}

/** Fills the suggested password into the new-password field(s) and offers to save the login. */
function applyGeneratedPassword(field: HTMLInputElement): void {
	const pw = suggestionFor.get(field);
	if (!pw) return;
	if (!fillPasswordFields(signupPasswordFields(field), pw)) return;
	// Grab whatever username/email the user already typed; the password is ours.
	const username = getPageFields().login.username?.value ?? "";
	// A signup creates a NEW login; a change form rotates the existing one. Tell the background
	// so a login already saved for this site doesn't turn a signup into an "update".
	const newLogin = !isPasswordChangeForm(field);
	safeSendMessage({ type: "CORNER_PROMPT_CAPTURE", payload: { username, password: pw, newLogin } });
}

/** Dismisses the dropdown and asks the background to fetch and fill the chosen entry. */
function selectMatch(entryId: string, isAuto: boolean, otpOnly = false): void {
	// Manual selection counts as an explicit dismissal; silence auto-redisplay
	// (e.g. a re-query landing mid-fill) until the user re-engages a field.
	if (!isAuto) silenceAutoOpen = true;
	picker.remove();
	safeSendMessage({
		type: "AUTOFILL_SELECT",
		payload: { entryId, hostname: location.hostname, isAuto, otpOnly },
	});
}

function focusedCandidate(): HTMLInputElement | null {
	const focused = deepActiveElement();
	return focused instanceof HTMLInputElement && isCandidate(getPageFields(), focused)
		? focused
		: null;
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
	if (silenceAutoOpen) {
		reshowField = null;
		return;
	}

	// Prefer the focused field; fall back to a pending re-show target (a post-unlock refresh
	// whose field lost focus to the popup). Consume the target either way.
	const target = focusedCandidate() ?? (reshowField?.isConnected ? reshowField : null);
	reshowField = null;
	if (!target) return;

	if (result.locked) {
		picker.showLocked(target);
		return;
	}

	const kind = kindOf(getPageFields(), target);
	if (kind === "card") {
		if (result.cards.length > 0) picker.showMatches(result.cards, target);
		return;
	}
	if (kind === "otp") {
		const otps = result.otps ?? [];
		if (otps.length > 0) picker.showMatches(otps, target, { otpOnly: true });
		return;
	}
	// login
	showLoginPicker(target, result.logins);
}

/** Asks the background what's available for this page, but only if a fillable field exists. */
function queryAutofill(): void {
	const fields = getPageFields();
	const hasLogin = !!(fields.login.username || fields.login.password);
	const hasCard = cardFieldsPresent(fields.card);
	const hasOtp = fields.otp.length > 0;
	if (!hasLogin && !hasCard && !hasOtp) return;

	safeSendMessage({
		type: "AUTOFILL_QUERY",
		hostname: location.hostname,
		hasLogin,
		hasCard,
		hasOtp,
	});
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
		picker.showLocked(field);
		return;
	}
	const kind = kindOf(getPageFields(), field);
	if (kind === "card") {
		if (cachedResult.cards.length > 0) picker.showMatches(cachedResult.cards, field);
		else queryAutofill();
		return;
	}
	if (kind === "otp") {
		const otps = cachedResult.otps ?? [];
		if (otps.length === 0) {
			queryAutofill();
		} else if (otps.length > 1 || !field.value) {
			// A single match auto-fills on load; only re-offer the picker on a
			// choice or an empty field.
			picker.showMatches(otps, field, { otpOnly: true });
		}
		return;
	}
	if (cachedResult.logins.length === 0) {
		// No cached matches: offer a strong password if this looks like a signup
		// form, and (re)query in case matches exist but weren't cached yet.
		const suggest = maybeSuggest(field, false);
		if (suggest) picker.showMatches([], field, { suggest });
		queryAutofill();
		return;
	}
	if (cachedResult.logins.length > 1 || !field.value) {
		showLoginPicker(field, cachedResult.logins);
	}
}

/** MutationObserver callback: SPA-submit fallback plus a throttled autofill re-query. */
function onDomChange(): void {
	// The DOM changed: drop the cached field model so the next read re-parses.
	invalidatePageFields();
	// SPA submit fallback: a password the user just edited whose field has now
	// vanished within the submit window is treated as a submit.
	maybeEmitSpaSubmit();
	const now = Date.now();
	if (now - lastCheck < 500) return;
	lastCheck = now;
	queryAutofill();
}

// The picker reports user actions through callbacks; the policy lives here.
picker.onPick((entryId, otpOnly) => selectMatch(entryId, false, otpOnly));
picker.onUnlockRequest(() => safeSendMessage({ type: "POPOUT_OPEN" }));
picker.onDismiss(() => {
	silenceAutoOpen = true;
});
picker.onUseSuggested(() => {
	const field = picker.anchorField();
	if (!field) return;
	// Using the suggestion is an explicit choice: fill, offer to save, then silence
	// auto-redisplay until the user re-engages.
	applyGeneratedPassword(field);
	silenceAutoOpen = true;
	picker.remove();
});
picker.onRegenerate(() => {
	const field = picker.anchorField();
	if (!field) return;
	const pw = generatePassword();
	suggestionFor.set(field, pw);
	// Suggestion-only prompt (no matches), matching showLoginPicker.
	picker.showMatches([], field, { suggest: { password: pw } });
});

// Disconnect the observer when the extension context is torn down.
onTeardown(() => {
	mutationObserver?.disconnect();
	mutationObserver = null;
});

// Enter inside a password field that drives no real `<form>` submit (lone
// inputs, ARIA pseudo-forms) is an effective submit; capture on it too. The
// open iframe dropdown gets first dibs on the key.
document.addEventListener(
	"keydown",
	(e) => {
		if (!e.isTrusted) return;
		// Drive the open iframe dropdown with the keyboard first.
		if (picker.handleKey(e)) return;
		onPasswordEnter(e);
	},
	true,
);

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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

	if (message?.type === "VAULT_LOCK_STATE") {
		// The background pushes lock changes here since content scripts can't watch
		// storage.session. Keep the cached flag honest and refresh whatever is open so a
		// stale "Vault locked" row clears on unlock (and stale matches hide on lock).
		const locked = (message.payload as { locked?: boolean } | undefined)?.locked === true;
		if (cachedResult) cachedResult.locked = locked;
		if (picker.activeHost()) {
			const focused = focusedCandidate();
			if (locked) {
				// Locked: swap to the "Vault locked" row on the focused field, or hide stale
				// matches when focus has left (don't pop the locked prompt on an idle field).
				if (focused) picker.showLocked(focused);
				else picker.remove();
			} else {
				// Unlocked: the row belongs to the picker's anchor field, which may no longer be
				// focused (unlocking via the toolbar/pop-out moves focus off the page). Re-query and
				// re-surface matches on that field so the stale "Vault locked" row is replaced in place.
				const field = focused ?? picker.anchorField();
				picker.remove();
				if (field) {
					reshowField = field;
					queryAutofill();
				}
			}
		}
		sendResponse({ ok: true });
		return false;
	}

	if (message?.type === "AUTOFILL_FILL") {
		const payload = message.payload as FillPayload;
		picker.removeDropdown();
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
			const target = composedTarget(e);
			if (!isCandidate(getPageFields(), target)) return;
			// Explicit focus re-arms auto-display after any prior silence.
			silenceAutoOpen = false;
			showFor(target);
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
			const target = composedTarget(e);
			if (!isCandidate(getPageFields(), target)) return;
			silenceAutoOpen = false;
			if (!cachedResult) {
				queryAutofill();
				return;
			}
			if (target.value && !cachedResult.locked) {
				// User is typing their own value: get out of the way unless there are
				// multiple matches of this field's kind to disambiguate.
				const kind = kindOf(getPageFields(), target);
				const count =
					kind === "card"
						? cachedResult.cards.length
						: kind === "otp"
							? (cachedResult.otps ?? []).length
							: cachedResult.logins.length;
				if (count <= 1) {
					picker.removeDropdown();
					return;
				}
			}
			showFor(target);
		},
		true,
	);

	// mousedown (not click): it fires before focusin, so a mousedown on a
	// `<label>` doesn't race us into an "open + immediate close" flash, and the
	// same listener detects re-engagement when the dropdown is closed.
	document.addEventListener(
		"mousedown",
		(e) => {
			const host = picker.activeHost();
			if (host) {
				const target = composedTarget(e);
				if (target instanceof Node) {
					// Clicks inside a cross-origin iframe never reach here.
					if (host.contains(target)) return;
					if (picker.clickIsOnAnchor(target)) return;
				}
				silenceAutoOpen = true;
				picker.remove();
				return;
			}
			// Picker closed: a mousedown on a candidate field is re-engagement.
			const target = composedTarget(e);
			if (isCandidate(getPageFields(), target)) {
				silenceAutoOpen = false;
				// Re-click on the already-focused field fires no focusin, so show ourselves.
				if (deepActiveElement() === target) showFor(target);
			}
		},
		true,
	);
	window.addEventListener("scroll", () => picker.reposition(), true);
	window.addEventListener("resize", () => picker.reposition(), true);
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", bootstrap);
} else {
	bootstrap();
}
