/// <reference types="chrome" />

// Content-script entry: bootstraps autofill and wires DOM events to the picker,
// capture, fill, and corner-prompt modules. Holds the page-level display policy
// (the cached query result and the auto-open silence flag); the picker reports
// user actions back through callbacks.

import { maybeCommitCapture, onPasswordEnter } from "./capture";
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
	isFilling,
	submitFromField,
} from "./fill";
import { installFrameRelay, type RelayRect } from "./frame-relay";
import { onTeardown, safeRequest, safeSendMessage } from "./lifecycle";
import { generatePassword } from "./password-gen";
import { picker } from "./picker";
import {
	closeRelayed,
	installRelayClient,
	keyToRelayed,
	relayedPickerIsOpen,
	repositionRelayed,
	showRelayed,
} from "./relay-client";
import { closeRelayHost, showRelayHost } from "./relay-host";
import {
	isAccountCreationForm,
	shouldSuggestPassword,
	signupPasswordFields,
} from "./signup-detect";
import type {
	AutofillQueryResponse,
	AutofillSelectResponse,
	AutofillSubmitRevalidationResponse,
	CornerPromptPayload,
	FillPayload,
	MatchSummary,
	QueryResult,
} from "./types";

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
// The field the user clicked "unlock" from. Clicking the locked row dismisses the picker, so on
// unlock there's no active host to refresh; we re-surface matches on this field instead.
let pendingUnlockField: HTMLInputElement | null = null;
let lastCheck = 0;
let queryGeneration = 0;
let submitGeneration = 0;

type TargetKind = "login" | "card" | "otp";
type ActiveFill = {
	target: HTMLInputElement;
	targetKind: TargetKind;
};

let activeFill: ActiveFill | null = null;

function cancelFill(): void {
	activeFill = null;
	submitGeneration++;
}

function cancelSubmit(): void {
	submitGeneration++;
}

function cancelOperations(): void {
	queryGeneration++;
	cancelFill();
}

function documentIsActive(): boolean {
	return document.visibilityState === "visible" && document.hasFocus();
}

// --- Picker placement -------------------------------------------------------
// A hosted-fields card input sits in an iframe barely taller than the input, where a
// dropdown is clipped away. Then an ancestor hosts the element and this frame keeps
// the conversation with it. See docs/autofill.md.

const frameRelay = installFrameRelay({ window, document });
// The field a relayed picker belongs to; picker.anchorField() is null in that mode.
let relayedField: HTMLInputElement | null = null;
let relayedHighlight = false;

function rectOf(field: HTMLInputElement): RelayRect {
	const r = field.getBoundingClientRect();
	return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function shouldRelay(field: HTMLInputElement): boolean {
	return !frameRelay.isTop() && frameRelay.needsRelay(rectOf(field));
}

/** The field the visible picker belongs to, whichever renderer is showing it. */
function anchorField(): HTMLInputElement | null {
	return picker.anchorField() ?? relayedField;
}

function dropRelayed(): void {
	relayedField = null;
	relayedHighlight = false;
	if (relayedPickerIsOpen()) closeRelayed();
}

/** True when a picker of either kind is on screen. */
function pickerIsOpen(): boolean {
	return !!picker.activeHost() || relayedPickerIsOpen();
}

/** Keep whichever picker is showing pinned to its field as the page moves. */
function repositionPicker(): void {
	picker.reposition();
	if (relayedField) repositionRelayed(rectOf(relayedField));
}

/** Dismiss whichever picker is showing. */
function removePicker(): void {
	picker.remove();
	dropRelayed();
}

function showMatchesFor(
	matches: MatchSummary[],
	field: HTMLInputElement,
	opts?: { otpOnly?: boolean; suggest?: { password: string } },
): void {
	if (matches.length === 0 && !opts?.suggest) return;
	if (!shouldRelay(field)) {
		dropRelayed();
		picker.showMatches(matches, field, opts);
		return;
	}
	picker.remove();
	relayedField = field;
	showRelayed(rectOf(field), {
		kind: "matches",
		matches,
		otpOnly: opts?.otpOnly === true,
		suggest: opts?.suggest,
	});
}

/** Arrow/Enter/Escape for a relayed picker; the field is here, the rows are upstairs. */
function handleRelayedKey(e: KeyboardEvent): boolean {
	if (!relayedPickerIsOpen() || deepActiveElement() !== relayedField) return false;
	if (e.key === "ArrowDown" || e.key === "ArrowUp") {
		e.preventDefault();
		keyToRelayed(e.key);
		return true;
	}
	if (e.key === "Escape") {
		e.preventDefault();
		silenceAutoOpen = true;
		dropRelayed();
		return true;
	}
	// Enter only picks when a row is highlighted; otherwise the form submits normally.
	if (e.key === "Enter" && relayedHighlight) {
		e.preventDefault();
		keyToRelayed("Enter");
		return true;
	}
	return false;
}

function showLockedFor(field: HTMLInputElement): void {
	if (!shouldRelay(field)) {
		dropRelayed();
		picker.showLocked(field);
		return;
	}
	picker.remove();
	relayedField = field;
	showRelayed(rectOf(field), { kind: "locked" });
}

function currentTargetKind(target: HTMLInputElement): TargetKind | null {
	invalidatePageFields();
	if (
		!target.isConnected ||
		target.ownerDocument !== document ||
		target.disabled ||
		target.readOnly
	) {
		return null;
	}
	return kindOf(getPageFields(), target);
}

function isPickerInteractionTarget(target: EventTarget | null): boolean {
	if (!(target instanceof Node)) return false;
	const host = picker.activeHost();
	return !!host && (host.contains(target) || picker.clickIsOnAnchor(target));
}

function responsePayload(v: unknown): {
	payload: FillPayload;
	isAuto: boolean;
	otpOnly: boolean;
	sessionGeneration: number;
} | null {
	if (!v || typeof v !== "object") return null;
	const data = v as Record<string, unknown>;
	if (data.isAuto !== true && data.isAuto !== false) return null;
	if (data.otpOnly !== true && data.otpOnly !== false) return null;
	if (!Number.isSafeInteger(data.sessionGeneration) || (data.sessionGeneration as number) < 0)
		return null;
	const payload = data.payload as FillPayload | undefined;
	if (!validFillPayload(payload)) return null;
	return {
		payload,
		isAuto: data.isAuto,
		otpOnly: data.otpOnly,
		sessionGeneration: data.sessionGeneration as number,
	};
}

function validCustomFields(value: unknown): boolean {
	return (
		value === undefined ||
		(Array.isArray(value) &&
			value.every(
				(field) =>
					field &&
					typeof field === "object" &&
					typeof (field as { key?: unknown }).key === "string" &&
					typeof (field as { value?: unknown }).value === "string",
			))
	);
}

function validFillPayload(payload: FillPayload | undefined): payload is FillPayload {
	if (!payload || typeof payload !== "object" || !validCustomFields(payload.customFields))
		return false;
	if (payload.kind === "login") {
		return (
			typeof payload.username === "string" &&
			typeof payload.password === "string" &&
			(payload.totp === undefined || typeof payload.totp === "string") &&
			(payload.autoSubmit === undefined || typeof payload.autoSubmit === "boolean")
		);
	}
	return (
		payload.kind === "card" &&
		typeof payload.cardholderName === "string" &&
		typeof payload.number === "string" &&
		typeof payload.expMonth === "string" &&
		typeof payload.expYear === "string" &&
		typeof payload.cvv === "string"
	);
}

function payloadMatchesTarget(
	targetKind: TargetKind,
	payload: FillPayload,
	otpOnly: boolean,
): boolean {
	if (targetKind === "card") return payload.kind === "card" && !otpOnly;
	if (targetKind === "otp") return payload.kind === "login" && otpOnly;
	return payload.kind === "login" && !otpOnly;
}

function delayedSubmitIsEligible(passwordField: HTMLInputElement, generation: number): boolean {
	invalidatePageFields();
	return (
		generation === submitGeneration &&
		documentIsActive() &&
		passwordField.isConnected &&
		passwordField.ownerDocument === document &&
		!passwordField.disabled &&
		!passwordField.readOnly &&
		getPageFields().login.password === passwordField &&
		!hasInteractiveCaptcha()
	);
}

async function continueAutoSubmit(
	passwordField: HTMLInputElement,
	generation: number,
	sessionGeneration: number,
): Promise<void> {
	if (!delayedSubmitIsEligible(passwordField, generation)) return;
	const response = await safeRequest<AutofillSubmitRevalidationResponse>({
		type: "AUTOFILL_REVALIDATE_SUBMIT",
		sessionGeneration,
	});
	if (
		!response?.ok ||
		response.data.sessionGeneration !== sessionGeneration ||
		!delayedSubmitIsEligible(passwordField, generation)
	) {
		return;
	}
	submitFromField(passwordField);
}

function applySelectResponse(
	intent: ActiveFill,
	response: AutofillSelectResponse | undefined,
): void {
	// Consume before validating or filling: a response can never be replayed locally.
	if (activeFill !== intent) return;
	activeFill = null;
	if (!response?.ok) return;
	const data = responsePayload(response.data);
	if (!data || !documentIsActive() || currentTargetKind(intent.target) !== intent.targetKind)
		return;
	if (!payloadMatchesTarget(intent.targetKind, data.payload, data.otpOnly)) return;

	picker.removeDropdown();
	if (data.payload.kind === "card") {
		fillCard(data.payload, data.isAuto);
		fillCustomFields(data.payload.customFields, data.isAuto);
		return;
	}
	if (data.otpOnly) {
		fillOtp(data.payload.totp);
		return;
	}
	const { filled, passwordField } = fillForm(
		data.payload.username,
		data.payload.password,
		data.isAuto,
	);
	fillCustomFields(data.payload.customFields, data.isAuto);
	fillOtp(data.payload.totp);
	if (!filled || !data.payload.autoSubmit || !passwordField) return;
	const generation = ++submitGeneration;
	setTimeout(() => {
		void continueAutoSubmit(passwordField, generation, data.sessionGeneration);
	}, 50);
}

/**
 * What was decided when the suggestion was first offered: the password, and whether
 * accepting it creates a login or rotates one.
 *
 * `newLogin` is settled HERE rather than at pick time because the picker rewrites the
 * anchor field's `autocomplete` to "off" to suppress the native dropdown, erasing the
 * `new-password` token that classifies the form. Re-reading the field after that scores
 * a signup as an ordinary page and turns its save into an update.
 */
interface Suggestion {
	password: string;
	newLogin: boolean;
}

// The suggestion offered on a given field, cached so re-renders don't churn a new
// one each frame. Regenerate replaces the password; the WeakMap forgets fields that
// leave the DOM.
const suggestionFor = new WeakMap<HTMLInputElement, Suggestion>();

/**
 * A generated-password suggestion for `field`, or null when this isn't a
 * password-setting flow. Decides once per field and caches it.
 */
function maybeSuggest(field: HTMLInputElement, hasExistingLogins: boolean): Suggestion | null {
	if (field.type !== "password" || field.value) return null;
	const cached = suggestionFor.get(field);
	if (cached) return cached;
	if (!shouldSuggestPassword(field, { hasExistingLogins })) return null;
	// Read the form while it still describes itself; see Suggestion.
	const suggestion = { password: generatePassword(), newLogin: isAccountCreationForm(field) };
	suggestionFor.set(field, suggestion);
	return suggestion;
}

/**
 * Swaps in a fresh password for `field`, keeping the save-vs-update decision the
 * first offer made: by now the picker has rewritten the anchor's autocomplete, so
 * re-classifying would read a form that no longer describes itself.
 */
function regenerateInto(field: HTMLInputElement): string {
	const password = generatePassword();
	suggestionFor.set(field, { password, newLogin: suggestionFor.get(field)?.newLogin ?? false });
	return password;
}

/** Shows the login picker for `field`: existing matches, or ONLY the strong-password row on a signup/rotation form. */
function showLoginPicker(field: HTMLInputElement, logins: MatchSummary[]): void {
	const suggest = maybeSuggest(field, logins.length > 0);
	// On an account-creation / password-rotation form, offer only the suggestion. Existing logins
	// aren't useful when making or rotating a credential and would clutter the prompt.
	if (suggest) {
		showMatchesFor([], field, { suggest: { password: suggest.password } });
		return;
	}
	if (logins.length === 0) return;
	showMatchesFor(logins, field);
}

/**
 * What to show on `field` while the vault is locked. Generating a strong password needs no vault,
 * so a signup field still gets the suggestion (picking it fills and offers an "Unlock & Save"
 * corner prompt); anything else falls back to the "Vault locked" unlock row.
 */
function showLockedPicker(field: HTMLInputElement, hasPotentialMatch: boolean): void {
	const suggest = maybeSuggest(field, hasPotentialMatch);
	if (suggest) showMatchesFor([], field, { suggest: { password: suggest.password } });
	else showLockedFor(field);
}

/** Fills the suggested password into the new-password field(s) and offers to save the login. */
function applyGeneratedPassword(field: HTMLInputElement): void {
	const suggestion = suggestionFor.get(field);
	if (!suggestion) return;
	const { password, newLogin } = suggestion;
	if (!fillPasswordFields(signupPasswordFields(field), password)) return;
	// Grab whatever username/email the user already typed; the password is ours.
	const username = getPageFields().login.username?.value ?? "";
	// A signup creates a NEW login; setting a password (reset, rotation, change form) rotates
	// the existing one. Tell the background so a login already saved for this site doesn't turn
	// a signup into an "update" -- and, just as importantly, so a reset doesn't duplicate it.
	safeSendMessage({ type: "CORNER_PROMPT_CAPTURE", payload: { username, password, newLogin } });
}

/**
 * Dismisses the dropdown and asks the background to fetch and fill the chosen entry.
 *
 * `into` overrides the target for a selection that did not come from the picker: the desktop
 * panel picks an entry with no dropdown open, and anchorField() is by definition the field a
 * VISIBLE picker belongs to, so it is null there and the fill silently did nothing.
 */
function selectMatch(
	entryId: string,
	isAuto: boolean,
	otpOnly = false,
	into: HTMLInputElement | null = anchorField(),
): void {
	const target = into;
	const targetKind = target ? currentTargetKind(target) : null;
	if (!target || !targetKind) return;
	// Manual selection counts as an explicit dismissal; silence auto-redisplay
	// (e.g. a re-query landing mid-fill) until the user re-engages a field.
	if (!isAuto) silenceAutoOpen = true;
	// Capture the actual anchor and its kind before removal. Never re-find by selector
	// when the response arrives: an identical replacement is a different target.
	const intent: ActiveFill = {
		target,
		targetKind,
	};
	cancelFill();
	activeFill = intent;
	picker.remove();
	dropRelayed();
	void safeRequest<AutofillSelectResponse>({
		type: "AUTOFILL_SELECT",
		payload: { entryId, isAuto, otpOnly },
	}).then((response) => applySelectResponse(intent, response));
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
		showLockedPicker(target, result.hasPotentialMatch);
		return;
	}

	const kind = kindOf(getPageFields(), target);
	if (kind === "card") {
		if (result.cards.length > 0) showMatchesFor(result.cards, target);
		return;
	}
	if (kind === "otp") {
		const otps = result.otps ?? [];
		if (otps.length > 0) showMatchesFor(otps, target, { otpOnly: true });
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

	const generation = ++queryGeneration;
	void safeRequest<AutofillQueryResponse>({
		type: "AUTOFILL_QUERY",
		hasLogin,
		hasCard,
		hasOtp,
	}).then((response) => {
		if (generation !== queryGeneration || !response?.ok) return;
		handleResult(response.data);
	});
}

/** Decides what (if anything) to show when the user focuses or edits `field`, based on the cached result. */
function showFor(field: HTMLInputElement): void {
	if (silenceAutoOpen) return;
	if (!cachedResult) {
		queryAutofill();
		return;
	}
	if (cachedResult.locked) {
		showLockedPicker(field, cachedResult.hasPotentialMatch);
		return;
	}
	const kind = kindOf(getPageFields(), field);
	if (kind === "card") {
		if (cachedResult.cards.length > 0) showMatchesFor(cachedResult.cards, field);
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
			showMatchesFor(otps, field, { otpOnly: true });
		}
		return;
	}
	if (cachedResult.logins.length === 0) {
		// No cached matches: offer a strong password if this looks like a signup
		// form, and (re)query in case matches exist but weren't cached yet.
		const suggest = maybeSuggest(field, false);
		if (suggest) showMatchesFor([], field, { suggest: { password: suggest.password } });
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
	// Commit checkpoint: an armed capture whose password field has now gone, or a
	// password the user just edited whose field vanished within the submit window.
	maybeCommitCapture();
	const now = Date.now();
	if (now - lastCheck < 500) return;
	lastCheck = now;
	queryAutofill();
}

// The picker reports user actions through callbacks; the policy lives here.
picker.onPick((entryId, otpOnly) => selectMatch(entryId, false, otpOnly));
picker.onUnlockRequest((field) => {
	cancelOperations();
	// The click dismissed the picker; remember the field so the unlock broadcast can re-surface here.
	pendingUnlockField = field;
	// `reason` marks this pop-out as a step in the fill flow, so it closes itself on unlock.
	safeSendMessage({ type: "POPOUT_OPEN", payload: { reason: "unlock" } });
});
picker.onDismiss(() => {
	cancelOperations();
	silenceAutoOpen = true;
});
picker.onUseSuggested(() => {
	cancelOperations();
	const field = anchorField();
	if (!field) return;
	// Using the suggestion is an explicit choice: fill, offer to save, then silence
	// auto-redisplay until the user re-engages.
	applyGeneratedPassword(field);
	silenceAutoOpen = true;
	picker.remove();
	dropRelayed();
});
picker.onRegenerate(() => {
	cancelOperations();
	const field = anchorField();
	if (!field) return;
	const pw = regenerateInto(field);
	// Suggestion-only prompt (no matches), matching showLoginPicker.
	showMatchesFor([], field, { suggest: { password: pw } });
});

// The top frame lends its document to descendants that have no room to draw; every
// other frame keeps its own conversation with the UI it borrows. Only one of these
// runs per frame.
if (frameRelay.isTop()) {
	frameRelay.onAnchor(showRelayHost);
	frameRelay.onClose(closeRelayHost);
} else {
	installRelayClient(frameRelay, {
		onPick: (entryId, otpOnly) => selectMatch(entryId, false, otpOnly),
		onHighlight: (active) => {
			relayedHighlight = active;
		},
		onPopout: () => {
			cancelOperations();
			const field = relayedField;
			dropRelayed();
			pendingUnlockField = field;
			safeSendMessage({ type: "POPOUT_OPEN", payload: { reason: "unlock" } });
		},
		onUseSuggested: () => {
			cancelOperations();
			const field = relayedField;
			if (!field) return;
			applyGeneratedPassword(field);
			silenceAutoOpen = true;
			dropRelayed();
		},
		onRegenerate: () => {
			cancelOperations();
			const field = relayedField;
			if (!field) return;
			const pw = regenerateInto(field);
			showMatchesFor([], field, { suggest: { password: pw } });
		},
	});
}

// Disconnect the observer when the extension context is torn down.
onTeardown(() => {
	mutationObserver?.disconnect();
	mutationObserver = null;
	cancelOperations();
	dropRelayed();
});

// Enter inside a password field that drives no real `<form>` submit (lone
// inputs, ARIA pseudo-forms) is an effective submit; capture on it too. The
// open iframe dropdown gets first dibs on the key.
document.addEventListener(
	"keydown",
	(e) => {
		if (!e.isTrusted) return;
		cancelOperations();
		// Drive the open iframe dropdown with the keyboard first.
		if (picker.handleKey(e)) return;
		if (handleRelayedKey(e)) return;
		onPasswordEnter(e.key, composedTarget(e));
	},
	true,
);

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message?.type === "CORNER_PROMPT_SHOW") {
		handleCornerPromptShow(message.payload as CornerPromptPayload);
		sendResponse({ ok: true });
		return false;
	}

	if (message?.type === "DESKTOP_FILL") {
		// A credential the desktop app is filling on this browser's behalf. It does NOT go through
		// AUTOFILL_SELECT: that reads this browser's own index, which is empty while locked, and
		// not having to unlock twice is the entire reason the link exists. The app authorized this
		// one — the user chose the entry there, against a page this browser reported.
		const fill = message.payload as
			| { username?: string; password?: string; totp?: string | null }
			| undefined;
		// The field the user left focused, else the page's own login field.
		const fields = getPageFields().login;
		const into = focusedCandidate() ?? fields.username ?? fields.password;
		const kind = into ? currentTargetKind(into) : null;
		if (!fill?.password || !into || !kind) {
			sendResponse({ ok: false, error: "no field to fill" });
			return false;
		}
		cancelFill();
		picker.remove();
		dropRelayed();
		fillForm(fill.username ?? "", fill.password, false);
		if (fill.totp) fillOtp(fill.totp);
		sendResponse({ ok: true });
		return false;
	}

	if (message?.type === "VAULT_LOCK_STATE") {
		// Either direction invalidates local response and delayed-submit work. A lock→unlock
		// ABA cannot revive a request that began before the transition: cancellation invalidates
		// both the pending fill identity and delayed-submit generation.
		cancelOperations();
		// The background pushes lock changes here since content scripts can't watch
		// storage.session. Keep the cached flag honest and refresh whatever is open so a
		// stale "Vault locked" row clears on unlock (and stale matches hide on lock).
		const locked = (message.payload as { locked?: boolean } | undefined)?.locked === true;
		if (cachedResult) cachedResult.locked = locked;
		const focused = focusedCandidate();
		if (locked) {
			// Lock only matters when a picker is open: swap to the "Vault locked" row on the focused
			// field (or keep the strong-password suggestion, which needs no vault), or hide stale
			// matches when focus has left. A fresh lock invalidates any pending unlock.
			if (pickerIsOpen()) {
				if (focused) showLockedPicker(focused, cachedResult?.hasPotentialMatch ?? false);
				else removePicker();
			}
			pendingUnlockField = null;
		} else {
			// Unlock: re-surface matches on the focused field, the open picker's anchor (toolbar/pop-out
			// unlock leaves the locked row up but moves focus off the page — issue #20), or the field the
			// user clicked "unlock" from (that click dismissed the picker, so there's no active host).
			const anchor = pickerIsOpen() ? anchorField() : null;
			const pending = pendingUnlockField?.isConnected ? pendingUnlockField : null;
			pendingUnlockField = null;
			const field = focused ?? anchor ?? pending;
			removePicker();
			if (field) {
				reshowField = field;
				queryAutofill();
			}
		}
		sendResponse({ ok: true });
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
			// Filling a segmented OTP widget focuses each box in turn, and focus()
			// fires a *trusted* focusin: without this the dropdown reopens on the last
			// box we filled. Not the user's focus, so nothing here should react to it.
			if (isFilling()) return;
			const target = composedTarget(e);
			if (e.isTrusted && !isPickerInteractionTarget(target)) cancelSubmit();
			// Do not treat extension-picker iframe focus as page deactivation. A real focus
			// change anywhere else in the page does supersede a picker-anchor operation.
			if (
				e.isTrusted &&
				activeFill &&
				target !== activeFill.target &&
				!isPickerInteractionTarget(target)
			) {
				cancelOperations();
			}
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
			cancelOperations();
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
		"pointerdown",
		(e) => {
			const target = composedTarget(e);
			if (e.isTrusted && !isPickerInteractionTarget(target)) cancelSubmit();
			if (e.isTrusted && activeFill && !isPickerInteractionTarget(target)) {
				cancelOperations();
			}
		},
		true,
	);

	document.addEventListener(
		"mousedown",
		(e) => {
			const target = composedTarget(e);
			if (e.isTrusted && !isPickerInteractionTarget(target)) cancelSubmit();
			if (e.isTrusted && activeFill && !isPickerInteractionTarget(target)) {
				if (target !== activeFill.target) cancelOperations();
			}
			const host = picker.activeHost();
			if (host) {
				if (target instanceof Node) {
					// Clicks inside a cross-origin iframe never reach here.
					if (host.contains(target)) return;
					if (picker.clickIsOnAnchor(target)) return;
				}
				silenceAutoOpen = true;
				picker.remove();
				return;
			}
			// A relayed picker has no host in this document, so a click anywhere here
			// other than its own field is a dismissal. Clicks on the rows land in the
			// top frame and never reach this listener.
			if (relayedPickerIsOpen() && target !== relayedField) {
				silenceAutoOpen = true;
				dropRelayed();
				return;
			}
			// Picker closed: a mousedown on a candidate field is re-engagement.
			if (isCandidate(getPageFields(), target)) {
				silenceAutoOpen = false;
				// Re-click on the already-focused field fires no focusin, so show ourselves.
				if (deepActiveElement() === target) showFor(target);
			}
		},
		true,
	);
	window.addEventListener("scroll", () => repositionPicker(), true);
	window.addEventListener("resize", () => repositionPicker(), true);
	window.addEventListener("pagehide", () => cancelOperations(), true);
	window.addEventListener("pageshow", (e) => {
		if (e.persisted) {
			cancelOperations();
			cachedResult = null;
			queryAutofill();
		}
	});
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState !== "visible") cancelOperations();
	});
	window.addEventListener("blur", () => {
		// Moving focus into the authenticated picker iframe keeps the top document focused.
		setTimeout(() => {
			if (!document.hasFocus()) cancelOperations();
		}, 0);
	});
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", bootstrap);
} else {
	bootstrap();
}
