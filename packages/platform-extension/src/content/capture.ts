import {
	composedTarget,
	deepQuery,
	deepQueryAll,
	detectLoginFields,
	findNewPasswordOnChangeForm,
	hasInteractiveCaptcha,
	otpInputs,
} from "./detection";
import { getLastFilledPassword } from "./fill";
import { safeSendMessage } from "./lifecycle";

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

	const pwFields = deepQueryAll('input[type="password"]:not([readonly]):not([disabled])');
	let capturePassword = lastUserEditedPassword;
	if (pwFields.length >= 2) {
		// Change form (old/new/confirm): only capture when the new-password field
		// is confidently identified and its confirm matches.
		const newField = findNewPasswordOnChangeForm();
		if (!newField) return null;
		capturePassword = newField.value;
	}
	// Suppress unchanged autofilled credentials: nothing to save.
	if (capturePassword === getLastFilledPassword()) return null;

	const username =
		login.username?.value ??
		deepQuery<HTMLInputElement>('input[autocomplete~="username"]')?.value ??
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

/** Enter inside a password field is an effective submit for forms with no native submit; capture on it. */
export function onPasswordEnter(e: KeyboardEvent): void {
	if (e.key !== "Enter") return;
	const target = composedTarget(e);
	if (!(target instanceof HTMLInputElement)) return;
	if (target.type !== "password") return;
	// A real submit event may also fire; the duplicate emitCapture is harmless.
	emitCapture();
}

/** SPA-submit fallback for the MutationObserver: a just-edited password field that vanished is a submit. */
export function maybeEmitSpaSubmit(): void {
	if (
		lastUserEditedPassword !== null &&
		Date.now() - lastEditAt < SPA_SUBMIT_WINDOW_MS &&
		!deepQuery('input[type="password"]:not([readonly]):not([disabled])')
	) {
		emitCapture();
	}
}

// Track user-typed password edits. Only `e.isTrusted` events (real keystrokes,
// not our own `fillField` dispatches) count.
document.addEventListener(
	"input",
	(e) => {
		if (!e.isTrusted) return;
		const target = composedTarget(e);
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
