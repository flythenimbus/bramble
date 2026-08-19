import {
	closestAcrossShadow,
	deriveMatcher,
	getFillableInputs,
	isRendered,
	matchesField,
	splitOtpFields,
} from "./detection";
import { getPageFields } from "./field-model";
import type { CustomFieldData, FillPayload } from "./types";

const BUBBLES = { bubbles: true, composed: true } as const;
const CANCELABLE = { ...BUBBLES, cancelable: true } as const;

/** Sets an input's value via the native setter so frameworks (React) observe the change. */
function setNativeValue(el: HTMLInputElement, value: string): void {
	const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
	desc?.set?.call(el, value);
}

/**
 * Writes `value` into `el` the way the browser does for real input: `beforeinput`
 * and `input` carry the inserted text and an `inputType`, and a single character
 * also gets its key events. A bare `new Event("input")` carries none of that, and
 * widgets that read `event.nativeEvent.data` rather than the field's value
 * (segmented code boxes, most formatted inputs) ignore it entirely.
 */
function insertValue(el: HTMLInputElement, value: string, inputType: string): void {
	const key = value.length === 1 ? value : null;
	if (key) el.dispatchEvent(new KeyboardEvent("keydown", { key, ...CANCELABLE }));
	el.dispatchEvent(new InputEvent("beforeinput", { data: value, inputType, ...CANCELABLE }));
	setNativeValue(el, value);
	el.dispatchEvent(new InputEvent("input", { data: value, inputType, ...BUBBLES }));
	if (key) el.dispatchEvent(new KeyboardEvent("keyup", { key, ...CANCELABLE }));
}

function fillField(el: HTMLInputElement, value: string): void {
	insertValue(el, value, "insertText");
	el.dispatchEvent(new Event("change", { bubbles: true }));
}

// Segmented widgets route keystrokes through whichever box has focus, so filling
// one means focusing each box in turn, and focus() fires a *trusted* focusin,
// which the dropdown would answer by reopening on the box we just filled.
// content.ts checks this flag before treating a focus as the user's.
let filling = false;

/** True while autofill is writing into page fields, so its focus moves aren't read as the user's. */
export function isFilling(): boolean {
	return filling;
}

// Auto-fill skips these so clearing a field isn't re-clobbered by the next
// query. Explicit dropdown selection ignores this set and always fills.
const autoFilledFields = new WeakSet<HTMLInputElement>();

/**
 * True if `el` must be left alone. A value WE wrote is fair game for an explicit
 * pick and off-limits to auto-fill; that asymmetry is the whole point of the set,
 * and it is what lets the user switch cards in the dropdown and see the new one
 * land. A value the USER typed is never clobbered here.
 */
function isReserved(el: HTMLInputElement, isAuto: boolean): boolean {
	if (!isRendered(el)) return true;
	if (autoFilledFields.has(el)) return isAuto;
	return el.value !== "";
}

// Last password we autofilled; capture compares against it to suppress "save"
// prompts for unchanged autofilled credentials.
let lastFilledPassword: string | null = null;

/** The last password written by autofill, for capture's unchanged-credential check. */
export function getLastFilledPassword(): string | null {
	return lastFilledPassword;
}

/** Fills the page's login fields. When `isAuto`, skips fields already auto-filled this session. */
export function fillForm(
	username: string,
	password: string,
	isAuto: boolean,
): {
	filled: boolean;
	passwordField: HTMLInputElement | null;
} {
	const { username: userField, password: pwField } = getPageFields().login;
	let filled = false;
	// Not isReserved(): an explicit pick replaces whatever the user typed into the
	// login fields, which is the point of choosing an entry from the dropdown.
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
 * Fills a generated password into the given fields (the new-password field plus
 * any confirm sibling). Records it as the last-filled password so a later real
 * submit won't re-prompt to save the same value. See signup-detect.ts.
 */
export function fillPasswordFields(fields: HTMLInputElement[], value: string): boolean {
	let filled = false;
	for (const el of fields) {
		fillField(el, value);
		autoFilledFields.add(el);
		filled = true;
	}
	if (filled) lastFilledPassword = value;
	return filled;
}

/**
 * Submits the form after autofill: prefers requestSubmit() on the enclosing
 * <form>, falling back to a synthesised Enter keypress for key-handler forms.
 */
export function submitFromField(field: HTMLInputElement | null): void {
	if (!field) return;
	const form = closestAcrossShadow(field, "form") as HTMLFormElement | null;
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
	const { login, card, otp } = getPageFields();
	if (login.username) reserved.add(login.username);
	if (login.password) reserved.add(login.password);
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
	for (const el of otp) reserved.add(el);
	return reserved;
}

/**
 * Fills each custom field into the first available page input whose hint matches its
 * derived name. Available means empty, or holding a value this module wrote on an
 * earlier pick -- otherwise switching entries would leave the previous one's custom
 * values behind, or worse, spill the new ones into a second matching input.
 */
export function fillCustomFields(fields: CustomFieldData[] | undefined, isAuto: boolean): void {
	if (!fields || fields.length === 0) return;
	const reserved = reservedInputs();
	const inputs = getFillableInputs().filter((el) => !reserved.has(el));
	for (const field of fields) {
		if (!field.value) continue;
		const matcher = deriveMatcher(field.key);
		if (!matcher) continue;
		for (const el of inputs) {
			if (isReserved(el, isAuto)) continue;
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

/**
 * Fills the page's card fields. `isAuto` follows the same contract as `fillForm`:
 * only auto-fill defers to what is already there. Picking a second card from the
 * dropdown must overwrite the first, which is what the unconditional guard here
 * used to prevent -- every field bailed and the previous card's expiry and CVV
 * stayed put, so the pick looked like it had chosen the wrong entry.
 *
 * Invisible fields are never written: a form that hides a box has taken it out of
 * the flow. See docs/autofill.md.
 */
export function fillCard(card: Extract<FillPayload, { kind: "card" }>, isAuto: boolean): boolean {
	const c = getPageFields().card;
	let filled = false;
	const put = (el: HTMLInputElement | null, value: string) => {
		if (!el || !value || !isRendered(el)) return;
		if (isAuto && autoFilledFields.has(el)) return;
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

/** True when the boxes hold `code`, one character each and nothing past its end. */
function boxesHold(boxes: HTMLInputElement[], code: string): boolean {
	return boxes.every((el, i) => el.value === (code[i] ?? ""));
}

/** Empties every box, so a strategy that didn't take can't leave digits behind for the next one. */
function clearBoxes(boxes: HTMLInputElement[]): void {
	for (const el of boxes) {
		if (!el.value) continue;
		el.focus();
		el.select();
		el.dispatchEvent(
			new InputEvent("beforeinput", { inputType: "deleteContentBackward", ...CANCELABLE }),
		);
		setNativeValue(el, "");
		el.dispatchEvent(new InputEvent("input", { inputType: "deleteContentBackward", ...BUBBLES }));
	}
}

/** Delivers the whole code as a clipboard paste, for widgets that only distribute one from `onPaste`. */
function pasteInto(el: HTMLInputElement, code: string): void {
	// Absent in jsdom, so the tests exercise the insertValue path below instead;
	// it reaches every widget that reads the field rather than the clipboard.
	if (typeof ClipboardEvent !== "function" || typeof DataTransfer !== "function") return;
	const clipboardData = new DataTransfer();
	clipboardData.setData("text/plain", code);
	el.dispatchEvent(new ClipboardEvent("paste", { clipboardData, ...CANCELABLE }));
}

/**
 * Fills a segmented widget: the whole code at once first, then a character per
 * box, checking after each attempt what the boxes actually hold.
 *
 * Nothing in the markup says which one a widget accepts. Per-box typing is the
 * general answer, but a widget that distributes a pasted code wants the code
 * whole (Cloudflare's 2FA form puts maxlength=6 on the first box for exactly
 * that), and one that only listens to its hidden mirror wants neither.
 */
function fillSegmented(
	boxes: HTMLInputElement[],
	whole: HTMLInputElement | null,
	code: string,
): void {
	const first = boxes[0]!;
	first.focus();
	first.select();
	pasteInto(first, code);
	if (!boxesHold(boxes, code)) {
		insertValue(first, code, "insertFromPaste");
		first.dispatchEvent(new Event("change", { bubbles: true }));
	}
	if (!boxesHold(boxes, code)) {
		clearBoxes(boxes);
		boxes.forEach((el, i) => {
			const ch = code[i];
			if (!ch) return;
			el.focus();
			fillField(el, ch);
		});
	}
	for (const el of boxes) autoFilledFields.add(el);
	// The mirror last: it carries the assembled code for the form, and on widgets
	// driven by it this is the write that makes the boxes show anything at all.
	// Never a single character of the code, and never the empty string past its
	// end: writing that is what used to blank the widget we had just filled.
	if (whole) {
		fillField(whole, code);
		autoFilledFields.add(whole);
	}
}

/** Fills the page's OTP field(s): the whole code into a single field, or across a segmented widget. */
export function fillOtp(code: string | undefined): boolean {
	if (!code) return false;
	const { boxes, whole } = splitOtpFields(getPageFields().otp);
	filling = true;
	try {
		if (boxes.length >= 2) {
			fillSegmented(boxes, whole, code);
			return true;
		}
		if (!whole) return false;
		fillField(whole, code);
		autoFilledFields.add(whole);
		return true;
	} finally {
		filling = false;
	}
}
