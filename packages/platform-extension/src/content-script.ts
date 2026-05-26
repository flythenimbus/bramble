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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message?.type === "AUTOFILL_MATCHES") {
		handleResult(message.payload as QueryResult | undefined);
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
