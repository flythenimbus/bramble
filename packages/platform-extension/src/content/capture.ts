import {
	closestAcrossShadow,
	composedTarget,
	deepQuery,
	deepQueryAll,
	detectLoginFields,
	findNewPasswordOnChangeForm,
	hasInteractiveCaptcha,
	isRendered,
	otpInputs,
} from "./detection";
import { getLastFilledPassword } from "./fill";
import { onTeardown, safeSendMessage } from "./lifecycle";
import { isAccountCreationForm } from "./signup-detect";

// Most recent user-typed password across all fields. Values we wrote via
// `fillForm` are not edits: gated on `e.isTrusted` below. Cleared on submit.
let lastUserEditedPassword: string | null = null;
let lastEditAt = 0;
// SPA submit fallback window: a password field vanishing within this many ms of
// the last edit is treated as a submit (React-removes-form, no native event).
const SPA_SUBMIT_WINDOW_MS = 1500;

/** A credential snapshot plus the password field it came from. */
interface Captured {
	username: string;
	password: string;
	newLogin: boolean;
	field: HTMLInputElement | null;
}

// A capture armed by a click on a submit control that drives no native `submit`
// event (formless SPA logins: no <form>, a plain <button> with a click handler).
// Unlike the submit/Enter paths this does not emit right away. The credential is
// snapshotted at click time, because by the time we commit the form is gone and
// there is nothing left to read; the commit itself waits for the password field
// to stop being rendered, which is the evidence that the login went through. A
// failed login leaves the field on screen, so the attempt expires unsaved.
interface ArmedCapture {
	captured: Captured;
	field: HTMLInputElement;
	at: number;
}
let armed: ArmedCapture | null = null;
const ARM_WINDOW_MS = 10_000;
// While armed, poll for the commit condition instead of relying on the
// MutationObserver: it only watches childList, so a form hidden by a class on an
// ancestor produces no callback. Bounded by ARM_WINDOW_MS and rare by nature.
const ARM_POLL_MS = 250;
let armTimer: ReturnType<typeof setInterval> | null = null;

function stopArmPolling(): void {
	if (armTimer === null) return;
	clearInterval(armTimer);
	armTimer = null;
}

function startArmPolling(): void {
	stopArmPolling();
	armTimer = setInterval(() => maybeCommitCapture(), ARM_POLL_MS);
}

/** Builds the capture payload from the current form state; returns null when any capture gate trips. */
function buildCapture(): Captured | null {
	if (lastUserEditedPassword === null) return null;
	// Don't fire a save prompt mid-CAPTCHA-challenge.
	if (hasInteractiveCaptcha()) return null;
	// OTP field present with no edited password: this submit is the 2FA confirm step.
	const login = detectLoginFields();
	if (otpInputs().length > 0 && !login.password) return null;

	const pwFields = deepQueryAll<HTMLInputElement>(
		'input[type="password"]:not([readonly]):not([disabled])',
	);
	let capturePassword = lastUserEditedPassword;
	let pwField = login.password;
	if (pwFields.length >= 2) {
		// Change form (old/new/confirm): only capture when the new-password field
		// is confidently identified and its confirm matches.
		const newField = findNewPasswordOnChangeForm();
		if (!newField) return null;
		capturePassword = newField.value;
		pwField = newField;
	}
	// Suppress unchanged autofilled credentials: nothing to save.
	if (capturePassword === getLastFilledPassword()) return null;

	const username =
		login.username?.value ??
		deepQuery<HTMLInputElement>('input[autocomplete~="username"]')?.value ??
		"";
	// A signup form yields a NEW login even when one is already saved for the site; a login or
	// change form does not (dedupe decides / rotates). See signup-detect.ts.
	const newLogin = !!pwField && isAccountCreationForm(pwField);
	return { username, password: capturePassword, newLogin, field: pwField };
}

/** Sends a captured credential and clears state so re-submits don't duplicate it. */
function send(captured: Captured): void {
	if (!captured.password) return;
	safeSendMessage({
		type: "CORNER_PROMPT_CAPTURE",
		payload: {
			username: captured.username,
			password: captured.password,
			newLogin: captured.newLogin,
		},
	});
	lastUserEditedPassword = null;
	disarm();
}

/** Drop any armed attempt and stop its polling. */
function disarm(): void {
	armed = null;
	stopArmPolling();
}

/** Emits a capture event from the live form state. */
function emitCapture(): void {
	const captured = buildCapture();
	if (!captured) return;
	send(captured);
}

/** Records a user-typed password. Re-typing invalidates any armed attempt (a retry after failure). */
export function notePasswordEdit(target: EventTarget | null): void {
	if (!(target instanceof HTMLInputElement)) return;
	if (target.type !== "password") return;
	lastUserEditedPassword = target.value;
	lastEditAt = Date.now();
	disarm();
}

/** A native form submit: emit synchronously, before the page can navigate away. */
export function onSubmit(): void {
	emitCapture();
}

/** Enter inside a password field is an effective submit for forms with no native submit; capture on it. */
export function onPasswordEnter(key: string, target: EventTarget | null): void {
	if (key !== "Enter") return;
	if (!(target instanceof HTMLInputElement)) return;
	if (target.type !== "password") return;
	// A real submit event may also fire; the duplicate emitCapture is harmless.
	emitCapture();
}

/**
 * True for a control that plausibly submits a login form. Deliberately narrow:
 * real <button>/<input> controls only. Sites put secondary actions right next to
 * the password field as `<span role="button">` (skanetrafiken's "Glömt
 * lösenord?"), and arming on those risks offering to save a password that was
 * never submitted. Password-visibility toggles are checkbox-ish, not submits.
 */
function isSubmitControl(el: Element): boolean {
	const ctl = closestAcrossShadow(
		el,
		'button, input[type="submit"], input[type="image"], input[type="button"]',
	);
	if (!ctl) return false;
	if (ctl instanceof HTMLButtonElement && ctl.type === "reset") return false;
	return !closestAcrossShadow(ctl, '[role="checkbox"], [role="switch"]');
}

/** A click on a submit control: snapshot the credential, to be committed once the login lands. */
export function onSubmitControlClick(target: EventTarget | null): void {
	if (lastUserEditedPassword === null) return;
	if (!(target instanceof Element)) return;
	if (!isSubmitControl(target)) return;
	const captured = buildCapture();
	if (!captured?.password || !captured.field) return;
	armed = { captured, field: captured.field, at: Date.now() };
	startArmPolling();
}

/** True once the field has left the document or stopped being rendered. */
function isGone(el: HTMLInputElement): boolean {
	return !el.isConnected || !isRendered(el);
}

/**
 * Commit checkpoint, driven by DOM mutations and SPA navigation. Runs both the
 * armed path and the legacy vanishing-field fallback.
 */
export function maybeCommitCapture(): void {
	if (armed) {
		if (Date.now() - armed.at > ARM_WINDOW_MS) {
			disarm();
		} else if (isGone(armed.field) && !hasInteractiveCaptcha()) {
			// The field the user submitted is gone: the login went through.
			send(armed.captured);
			return;
		}
	}
	maybeEmitSpaSubmit();
}

/** SPA-submit fallback: a just-edited password field that vanished is a submit. */
export function maybeEmitSpaSubmit(): void {
	if (
		lastUserEditedPassword !== null &&
		Date.now() - lastEditAt < SPA_SUBMIT_WINDOW_MS &&
		!deepQuery('input[type="password"]:not([readonly]):not([disabled])')
	) {
		emitCapture();
	}
}

/** Test seam: drop all pending capture state. */
export function resetCaptureState(): void {
	lastUserEditedPassword = null;
	lastEditAt = 0;
	disarm();
}

/** Wires the document-level listeners that feed the capture state machine. */
export function installCaptureListeners(doc: Document = document): void {
	// Track user-typed password edits. Only `e.isTrusted` events (real keystrokes,
	// not our own `fillField` dispatches) count.
	doc.addEventListener(
		"input",
		(e) => {
			if (!e.isTrusted) return;
			notePasswordEdit(composedTarget(e));
		},
		true,
	);

	// Capture phase so we see the event before any handler that preventDefaults and
	// rebuilds the DOM.
	doc.addEventListener("submit", () => onSubmit(), true);

	// Formless SPA logins fire no submit event; the click is all we get.
	doc.addEventListener(
		"click",
		(e) => {
			if (!e.isTrusted) return;
			onSubmitControlClick(composedTarget(e));
		},
		true,
	);

	// SPA route changes that hide the form without a childList mutation the
	// observer would see. pushState fires no event and can't be patched from the
	// isolated world, which is why the armed path polls rather than trusting these.
	const view = doc.defaultView;
	view?.addEventListener("hashchange", () => maybeCommitCapture());
	view?.addEventListener("popstate", () => maybeCommitCapture());
}

onTeardown(stopArmPolling);

installCaptureListeners();
