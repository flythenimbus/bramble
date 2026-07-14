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
import { fillCard, fillCustomFields, fillForm, fillOtp, submitFromField } from "./fill";
import { onTeardown, safeSendMessage } from "./lifecycle";
import { picker } from "./picker";
import type { CornerPromptPayload, FillPayload, QueryResult } from "./types";

let mutationObserver: MutationObserver | null = null;

// `null` until the first query response: distinguishes "unknown" from "queried,
// came back empty" (a locked default would flash "Vault locked" on every load).
let cachedResult: QueryResult | null = null;
// Set when the user explicitly closes the popover; suppresses redisplay from
// re-queries until they re-engage (focus, type, or mousedown on a field).
let silenceAutoOpen = false;
let lastCheck = 0;

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
	if (silenceAutoOpen) return;

	const focused = focusedCandidate();
	if (!focused) return;

	if (result.locked) {
		picker.showLocked(focused);
		return;
	}

	const kind = kindOf(getPageFields(), focused);
	if (kind === "card") {
		if (result.cards.length > 0) picker.showMatches(result.cards, focused);
		return;
	}
	if (kind === "otp") {
		const otps = result.otps ?? [];
		if (otps.length > 0) picker.showMatches(otps, focused, { otpOnly: true });
		return;
	}
	// login
	if (result.logins.length > 0) picker.showMatches(result.logins, focused);
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
		queryAutofill();
		return;
	}
	if (cachedResult.logins.length > 1 || !field.value) {
		picker.showMatches(cachedResult.logins, field);
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
		const focused = focusedCandidate();
		if (picker.activeHost() && focused) {
			if (locked) {
				picker.showLocked(focused);
			} else {
				picker.remove();
				queryAutofill();
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
