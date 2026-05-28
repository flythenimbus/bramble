/// <reference types="chrome" />


let extensionAlive = true;
let mutationObserver: MutationObserver | null = null;

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

interface LoginFields {
	username: HTMLInputElement | null;
	password: HTMLInputElement | null;
}

interface CardFields {
	number: HTMLInputElement | null;
	name: HTMLInputElement | null;
	// A single MM/YY field, used only when no split month/year pair is present.
	expCombined: HTMLInputElement | null;
	expMonth: HTMLInputElement | null;
	expYear: HTMLInputElement | null;
	cvv: HTMLInputElement | null;
}


const USERNAME_HINT_RE = /email|e-mail|user|login|account|signin|sign-in/i;
const NEGATIVE_HINT_RE = /search|captcha|coupon|otp|code/i;

const USERNAME_TEXT_SELECTOR =
	'input[type="text"]:not([readonly]):not([disabled]), input[type="email"]:not([readonly]):not([disabled]), input[type="tel"]:not([readonly]):not([disabled]), input:not([type]):not([readonly]):not([disabled])';

function findPasswordField(): HTMLInputElement | null {
	return document.querySelector<HTMLInputElement>(
		'input[type="password"]:not([readonly]):not([disabled])',
	);
}

function attrHint(el: HTMLInputElement): string {
	return `${el.name} ${el.id} ${el.placeholder} ${el.autocomplete} ${el.getAttribute("aria-label") ?? ""}`;
}

// `<label for=id>`, a wrapping <label>, or `aria-labelledby` targets. Used only
// as a low-priority fallback when a field's own attributes are uninformative —
// many forms carry the only human-readable hint in the label, with opaque
// name/id.
function labelText(el: HTMLInputElement): string {
	const parts: string[] = [];
	if (el.id) {
		const sel = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(el.id) : el.id;
		try {
			for (const lbl of document.querySelectorAll<HTMLLabelElement>(`label[for="${sel}"]`)) {
				parts.push(lbl.textContent ?? "");
			}
		} catch {
		}
	}
	const wrapping = el.closest("label");
	if (wrapping) parts.push(wrapping.textContent ?? "");
	const labelledby = el.getAttribute("aria-labelledby");
	if (labelledby) {
		for (const id of labelledby.split(/\s+/)) {
			if (!id) continue;
			const ref = document.getElementById(id);
			if (ref) parts.push(ref.textContent ?? "");
		}
	}
	return parts.join(" ");
}

function looksLikeUsername(el: HTMLInputElement): boolean {
	const hint = attrHint(el);
	if (NEGATIVE_HINT_RE.test(hint)) return false;
	if (el.type === "email") return true;
	const autocomplete = el.autocomplete?.toLowerCase() ?? "";
	if (autocomplete.includes("username") || autocomplete === "email") return true;
	return USERNAME_HINT_RE.test(hint);
}

function findUsernameNearPassword(password: HTMLInputElement): HTMLInputElement | null {
	const form = password.closest("form");
	const scope: ParentNode = form ?? document;
	const candidates = scope.querySelectorAll<HTMLInputElement>(USERNAME_TEXT_SELECTOR);
	let best: HTMLInputElement | null = null;
	for (const c of candidates) {
		if (c === password) continue;
		if (NEGATIVE_HINT_RE.test(attrHint(c))) continue;
		const pos = c.compareDocumentPosition(password);
		if (pos & Node.DOCUMENT_POSITION_FOLLOWING) {
			best = c;
		}
	}
	return best;
}

function detectLoginFields(): LoginFields {
	const password = findPasswordField();

	// 1. If there's a password field, the nearest preceding text input is the
	//    username — that pairing is by far the most reliable signal.
	if (password) {
		const near = findUsernameNearPassword(password);
		if (near) return { username: near, password };
	}

	// 2. Explicit autocomplete tokens take priority over heuristics.
	const explicit = document.querySelector<HTMLInputElement>(
		'input[autocomplete~="username"]:not([readonly]):not([disabled]), input[autocomplete="email"]:not([readonly]):not([disabled])',
	);
	if (explicit) return { username: explicit, password };

	// 3. A single visible email input is almost always the username.
	const email = document.querySelector<HTMLInputElement>(
		'input[type="email"]:not([readonly]):not([disabled])',
	);
	if (email) return { username: email, password };

	// 4. Fall back to attribute heuristics on text inputs.
	const candidates = document.querySelectorAll<HTMLInputElement>(USERNAME_TEXT_SELECTOR);
	for (const c of candidates) {
		if (looksLikeUsername(c)) return { username: c, password };
	}

	// 5. Last resort: the field's associated <label> text — some forms put the
	//    only human-readable hint there and leave name/id opaque.
	for (const c of candidates) {
		const lbl = labelText(c);
		if (!lbl || NEGATIVE_HINT_RE.test(lbl)) continue;
		if (USERNAME_HINT_RE.test(lbl)) return { username: c, password };
	}

	return { username: null, password };
}

// ── Payment-field detection ───────────────────────────────────────────────────

const CC_NUMBER_RE = /card.?number|cardnum|ccnum|cc.?number/i;
const CC_NAME_RE = /cardholder|name.?on.?card|cc.?name/i;
const CC_EXP_RE = /expir(y|ation)/i;
const CC_EXP_MONTH_RE = /exp.*month|cc.?month|card.*month/i;
const CC_EXP_YEAR_RE = /exp.*year|cc.?year|card.*year/i;
const CC_CSC_RE =
	/\bcvv\b|\bcvc\b|\bcsc\b|security.?code|card.?code|verification.?(no|number|code)/i;

function ccByToken(token: string): HTMLInputElement | null {
	return document.querySelector<HTMLInputElement>(
		`input[autocomplete~="${token}"]:not([readonly]):not([disabled])`,
	);
}

// First visible input whose attribute hint matches `re`. Password-typed inputs
// are skipped unless `allowPassword` (a CVV is sometimes type=password).
function findByHint(re: RegExp, exclude?: RegExp, allowPassword = false): HTMLInputElement | null {
	const inputs: HTMLInputElement[] = [];
	for (const el of document.querySelectorAll<HTMLInputElement>(
		"input:not([readonly]):not([disabled])",
	)) {
		if (el.type === "hidden" || el.type === "checkbox" || el.type === "radio") continue;
		if (el.type === "password" && !allowPassword) continue;
		inputs.push(el);
	}
	for (const el of inputs) {
		const hint = attrHint(el);
		if (exclude?.test(hint)) continue;
		if (re.test(hint)) return el;
	}
	for (const el of inputs) {
		const lbl = labelText(el);
		if (!lbl || exclude?.test(lbl)) continue;
		if (re.test(lbl)) return el;
	}
	return null;
}

function detectCardFields(): CardFields {
	const number = ccByToken("cc-number") ?? findByHint(CC_NUMBER_RE);
	const name = ccByToken("cc-name") ?? findByHint(CC_NAME_RE);
	const expMonth = ccByToken("cc-exp-month") ?? findByHint(CC_EXP_MONTH_RE);
	const expYear = ccByToken("cc-exp-year") ?? findByHint(CC_EXP_YEAR_RE);
	const expCombined =
		!expMonth && !expYear ? (ccByToken("cc-exp") ?? findByHint(CC_EXP_RE, /month|year/i)) : null;
	const cvv = ccByToken("cc-csc") ?? findByHint(CC_CSC_RE, undefined, true);
	return { number, name, expCombined, expMonth, expYear, cvv };
}

// A bare cardholder-name field is too weak a signal on its own; require a real
// card field before offering the card picker.
function cardFieldsPresent(c: CardFields): boolean {
	return !!(c.number || c.cvv || c.expCombined || c.expMonth || c.expYear);
}

function isCardField(c: CardFields, el: HTMLInputElement): boolean {
	return (
		el === c.number ||
		el === c.name ||
		el === c.expCombined ||
		el === c.expMonth ||
		el === c.expYear ||
		el === c.cvv
	);
}

// ── One-time-code (TOTP) field detection ─────────────────────────────────────

const OTP_HINT_RE =
	/one.?time|\botp\b|2fa|mfa|two.?factor|authenticator|auth.?code|login.?code|verif(y|ication).?code|confirmation.?code|passcode|\btotp\b|6.?digit/i;
// Keep card / address / coupon fields out of OTP detection. A CVV is also a card
// field (excluded via isCardField below); these guard the standalone case.
const OTP_NEGATIVE_RE = /card|coupon|promo|postal|\bzip\b|country|address|phone/i;

// The contiguous run of single-character, text-like inputs that `seed` belongs
// to, in DOM order — the shape of a segmented OTP widget (N one-char boxes).
function segmentedSiblings(seed: HTMLInputElement): HTMLInputElement[] {
	const parent = seed.parentElement;
	if (!parent) return [seed];
	const siblings = Array.from(parent.querySelectorAll<HTMLInputElement>("input")).filter(
		(el) =>
			!el.readOnly &&
			!el.disabled &&
			el.maxLength === 1 &&
			(el.type === "text" || el.type === "tel" || el.type === "number" || el.type === ""),
	);
	return siblings.length >= 2 ? siblings : [seed];
}

// single field; some sites split it into N single-character boxes (segmented).
function otpInputs(): HTMLInputElement[] {
	const tokened = Array.from(
		document.querySelectorAll<HTMLInputElement>(
			'input[autocomplete~="one-time-code"]:not([readonly]):not([disabled])',
		),
	);
	if (tokened.length >= 1) return tokened;

	const card = detectCardFields();
	let hinted: HTMLInputElement | null = null;
	for (const el of document.querySelectorAll<HTMLInputElement>(
		"input:not([readonly]):not([disabled])",
	)) {
		if (el.type === "password" || el.type === "hidden" || el.type === "checkbox") continue;
		if (el.type === "radio" || el.type === "submit" || el.type === "button") continue;
		if (isCardField(card, el)) continue;
		const hint = attrHint(el);
		if (OTP_NEGATIVE_RE.test(hint)) continue;
		if (OTP_HINT_RE.test(hint)) {
			hinted = el;
			break;
		}
		const lbl = labelText(el);
		if (lbl && !OTP_NEGATIVE_RE.test(lbl) && OTP_HINT_RE.test(lbl)) {
			hinted = el;
			break;
		}
	}
	if (!hinted) return [];
	// A single-character field is one box of a segmented widget — gather the run.
	if (hinted.maxLength === 1) {
		const group = segmentedSiblings(hinted);
		if (group.length >= 2) return group;
	}
	return [hinted];
}

// Which autofill dropdown (if any) a field should drive. Card detection runs
// first so a password-typed CVV is classified as a card field, not a login;
// OTP runs last so it only claims fields nothing else owns.
function candidateKind(el: EventTarget | null): "login" | "card" | "otp" | null {
	if (!(el instanceof HTMLInputElement)) return null;
	if (el.readOnly || el.disabled) return null;
	const card = detectCardFields();
	if (cardFieldsPresent(card) && isCardField(card, el)) return "card";
	if (el.type === "password") return "login";
	const login = detectLoginFields();
	if (el === login.username) return "login";
	if (otpInputs().includes(el)) return "otp";
	return null;
}

function isAutofillCandidate(el: EventTarget | null): el is HTMLInputElement {
	return candidateKind(el) !== null;
}


function setNativeValue(el: HTMLInputElement, value: string): void {
	const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
	desc?.set?.call(el, value);
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

function fillField(el: HTMLInputElement, value: string): void {
	setNativeValue(el, value);
	el.dispatchEvent(new Event("change", { bubbles: true }));
}

const autoFilledFields = new WeakSet<HTMLInputElement>();

let lastFilledPassword: string | null = null;

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

const CAPTCHA_SELECTORS = [
	".g-recaptcha:not([data-size='invisible'])",
	".h-captcha",
	".cf-turnstile",
	'iframe[src*="recaptcha/api2/anchor"]',
	'iframe[src*="recaptcha/api2/bframe"]',
	'iframe[src*="hcaptcha.com"]',
	'iframe[src*="challenges.cloudflare.com"]',
	'iframe[src*="arkoselabs.com"]',
	'iframe[src*="funcaptcha.com"]',
	'iframe[title*="captcha" i]',
];

function isRendered(el: Element): boolean {
	const rect = el.getBoundingClientRect();
	if (rect.width < 10 || rect.height < 10) return false;
	const style = getComputedStyle(el);
	return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

function hasInteractiveCaptcha(): boolean {
	for (const sel of CAPTCHA_SELECTORS) {
		for (const el of document.querySelectorAll(sel)) {
			if (isRendered(el)) return true;
		}
	}
	return false;
}


interface FieldMatcher {
	canonical: string;
	hyphen: string;
}

function deriveMatcher(key: string): FieldMatcher | null {
	const words = key.toLowerCase().match(/[a-z0-9]+/g);
	if (!words || words.length === 0) return null;
	return { canonical: words.join(""), hyphen: words.join("-") };
}

// Inputs a custom field may fill: text-like only. Password/email are excluded so
// a stray match can't dump a custom value into a credential or email field.
const CUSTOM_FILLABLE_TYPES = new Set(["text", "tel", "number", "search", "url", ""]);

function getFillableInputs(): HTMLInputElement[] {
	const out: HTMLInputElement[] = [];
	for (const el of document.querySelectorAll<HTMLInputElement>("input")) {
		if (el.readOnly || el.disabled) continue;
		if (!CUSTOM_FILLABLE_TYPES.has(el.type)) continue;
		out.push(el);
	}
	return out;
}

function matchesField(el: HTMLInputElement, m: FieldMatcher): boolean {
	const ac = el.autocomplete?.toLowerCase().trim();
	if (ac) {
		for (const token of ac.split(/\s+/)) {
			if (token === m.hyphen) return true;
			if (token.replace(/[^a-z0-9]/g, "") === m.canonical) return true;
		}
	}
	for (const raw of [
		el.name,
		el.id,
		el.getAttribute("aria-label") ?? "",
		el.placeholder,
		labelText(el),
	]) {
		const a = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
		if (!a) continue;
		// Exact normalized match at any length; substring only for longer keys, so
		// short names like "name" / "city" can't match "username" / "velocity".
		if (a === m.canonical) return true;
		if (m.canonical.length >= 5 && a.includes(m.canonical)) return true;
	}
	return false;
}

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
let cachedResult: QueryResult | null = null;
let anchorField: HTMLInputElement | null = null;
let openMatchesKey = "";
let openDropdownKind: "matches" | "locked" | null = null;
let silenceAutoOpen = false;

function matchesKey(matches: MatchSummary[]): string {
	let out = "";
	for (const m of matches) out += `${m.id}\0`;
	return out;
}

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
	const width = Math.max(rect.width / 3, 240);
	dropdownEl.style.width = `${width}px`;
}

function initials(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) return "??";
	const words = trimmed.split(/\s+/);
	if (words.length >= 2 && words[0] && words[1]) {
		return (words[0][0]! + words[1][0]!).toUpperCase();
	}
	return trimmed.slice(0, 2).toUpperCase();
}

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
	root.style.cssText = "position: absolute; z-index: 2147483647;";
	root.innerHTML = dropdownStyles() + bodyHtml;

	dropdownEl = root;
	document.body.appendChild(dropdownEl);
	positionDropdown(field);
	return root;
}

function buildDropdown(
	matches: MatchSummary[],
	field: HTMLInputElement,
	opts?: { otpOnly?: boolean },
): void {
	if (matches.length === 0) return;

	const key = matchesKey(matches);
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

	root.addEventListener("mousedown", (e) => {
		const item = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-tp-popout]");
		if (!item) return;
		e.preventDefault();
		removeDropdown();
		safeSendMessage({ type: "POPOUT_OPEN" });
	});
}

function selectMatch(entryId: string, isAuto: boolean, otpOnly = false): void {
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

function handleResult(result: QueryResult | undefined): void {
	if (!isQueryResult(result)) return;
	cachedResult = result;

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


let lastUserEditedPassword: string | null = null;
let lastEditAt = 0;
const SPA_SUBMIT_WINDOW_MS = 1500;

// Detect a password-change form. Returns the user-edited "new password" field
// when the page has multiple password fields AND we can confidently pick the
// new-password one and confirm it against a matching second field. Returns
// null when the form is ambiguous or mid-edit — better to skip the prompt
// than to capture (and offer to save) an unconfirmed new password.
function findNewPasswordOnChangeForm(): HTMLInputElement | null {
	const fields = Array.from(
		document.querySelectorAll<HTMLInputElement>(
			'input[type="password"]:not([readonly]):not([disabled])',
		),
	);
	if (fields.length < 2) return null;
	const NEW_RE = /new|set/i;
	const OLD_OR_CONFIRM_RE = /old|current|confirm|verify|repeat|re.?type|again/i;
	let candidate: HTMLInputElement | null = null;
	for (const el of fields) {
		const hint = `${el.autocomplete ?? ""} ${attrHint(el)} ${labelText(el) ?? ""}`;
		if (OLD_OR_CONFIRM_RE.test(hint)) continue;
		if (el.autocomplete?.toLowerCase().includes("new-password") || NEW_RE.test(hint)) {
			candidate = el;
			break;
		}
	}
	if (!candidate?.value) return null;
	// Look for a matching confirmation field — same value. Without it the
	// user is mid-typing and we shouldn't capture (would race the user's
	// second-field edit).
	for (const el of fields) {
		if (el === candidate) continue;
		if (el.value === candidate.value) return candidate;
	}
	return null;
}

// Build the capture payload — username + the user-edited password — from the
// current page state. Returns null when any capture gate trips.
function buildCapture(): { username: string; password: string } | null {
	if (lastUserEditedPassword === null) return null;
	if (hasInteractiveCaptcha()) return null;
	const login = detectLoginFields();
	if (otpInputs().length > 0 && !login.password) return null;

	const pwFields = document.querySelectorAll(
		'input[type="password"]:not([readonly]):not([disabled])',
	);
	let capturePassword = lastUserEditedPassword;
	if (pwFields.length >= 2) {
		const newField = findNewPasswordOnChangeForm();
		if (!newField) return null;
		capturePassword = newField.value;
	}
	if (capturePassword === lastFilledPassword) return null;

	const username =
		login.username?.value ??
		document.querySelector<HTMLInputElement>('input[autocomplete~="username"]')?.value ??
		"";
	return { username, password: capturePassword };
}

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

document.addEventListener(
	"submit",
	() => {
		emitCapture();
	},
	true,
);

document.addEventListener(
	"keydown",
	(e) => {
		if (!e.isTrusted) return;
		if (e.key !== "Enter") return;
		const target = e.target;
		if (!(target instanceof HTMLInputElement)) return;
		if (target.type !== "password") return;
		emitCapture();
	},
	true,
);

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

function buildUpdateLoginBody(p: Extract<CornerPromptPayload, { kind: "update-login" }>): string {
	const primaryLabel = p.locked ? "Unlock & Update" : "Update";
	const primaryAction = p.locked ? "save-unlock-first" : "update";
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

function handleCornerCardClick(e: Event): void {
	const target = e.target;
	if (!(target instanceof HTMLElement)) return;
	const actionEl = target.closest<HTMLElement>("[data-tp-action]");
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
		fillOtp(payload.totp);
		if (filled && payload.autoSubmit) {
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
function onDomChange(): void {
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

function showFor(field: HTMLInputElement): void {
	if (silenceAutoOpen) return;
	if (!cachedResult) {
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

function bootstrap(): void {
	queryAutofill();
	queryCornerPrompt();

	mutationObserver = new MutationObserver(() => onDomChange());
	mutationObserver.observe(document.body, { childList: true, subtree: true });

	document.addEventListener(
		"focusin",
		(e) => {
			if (!isAutofillCandidate(e.target)) return;
			silenceAutoOpen = false;
			showFor(e.target);
		},
		true,
	);

	document.addEventListener(
		"input",
		(e) => {
			if (!e.isTrusted) return;
			if (!isAutofillCandidate(e.target)) return;
			silenceAutoOpen = false;
			if (!cachedResult) {
				queryAutofill();
				return;
			}
			if (e.target.value && !cachedResult.locked) {
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
			const target = e.target;
			if (isAutofillCandidate(target)) {
				silenceAutoOpen = false;
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
