
export interface LoginFields {
	username: HTMLInputElement | null;
	password: HTMLInputElement | null;
}

export const USERNAME_HINT_RE = /email|e-mail|user|login|account|signin|sign-in/i;
export const NEGATIVE_HINT_RE = /search|captcha|coupon|otp|code/i;

const USERNAME_TEXT_SELECTOR =
	'input[type="text"]:not([readonly]):not([disabled]), input[type="email"]:not([readonly]):not([disabled]), input[type="tel"]:not([readonly]):not([disabled]), input:not([type]):not([readonly]):not([disabled])';

export function findPasswordField(doc: Document = document): HTMLInputElement | null {
	return doc.querySelector<HTMLInputElement>(
		'input[type="password"]:not([readonly]):not([disabled])',
	);
}

export function attrHint(el: HTMLInputElement): string {
	return `${el.name} ${el.id} ${el.placeholder} ${el.autocomplete} ${el.getAttribute("aria-label") ?? ""}`;
}

export function labelText(el: HTMLInputElement, doc: Document = document): string {
	const parts: string[] = [];
	if (el.id) {
		const sel = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(el.id) : el.id;
		try {
			for (const lbl of doc.querySelectorAll<HTMLLabelElement>(`label[for="${sel}"]`)) {
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
			const ref = doc.getElementById(id);
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

export function findUsernameNearPassword(password: HTMLInputElement): HTMLInputElement | null {
	const form = password.closest("form");
	const scope: ParentNode = form ?? password.ownerDocument;
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


export interface CardFields {
	number: HTMLInputElement | null;
	name: HTMLInputElement | null;
	expCombined: HTMLInputElement | null;
	expMonth: HTMLInputElement | null;
	expYear: HTMLInputElement | null;
	cvv: HTMLInputElement | null;
}

export const CC_NUMBER_RE = /card.?number|cardnum|ccnum|cc.?number/i;
export const CC_NAME_RE = /cardholder|name.?on.?card|cc.?name/i;
export const CC_EXP_RE = /expir(y|ation)/i;
export const CC_EXP_MONTH_RE = /exp.*month|cc.?month|card.*month/i;
export const CC_EXP_YEAR_RE = /exp.*year|cc.?year|card.*year/i;
export const CC_CSC_RE =
	/\bcvv\b|\bcvc\b|\bcsc\b|security.?code|card.?code|verification.?(no|number|code)/i;

export function ccByToken(token: string, doc: Document = document): HTMLInputElement | null {
	return doc.querySelector<HTMLInputElement>(
		`input[autocomplete~="${token}"]:not([readonly]):not([disabled])`,
	);
}

export function findByHint(
	re: RegExp,
	exclude?: RegExp,
	allowPassword = false,
	doc: Document = document,
): HTMLInputElement | null {
	const inputs: HTMLInputElement[] = [];
	for (const el of doc.querySelectorAll<HTMLInputElement>(
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
		const lbl = labelText(el, doc);
		if (!lbl || exclude?.test(lbl)) continue;
		if (re.test(lbl)) return el;
	}
	return null;
}

export function detectCardFields(doc: Document = document): CardFields {
	const number = ccByToken("cc-number", doc) ?? findByHint(CC_NUMBER_RE, undefined, false, doc);
	const name = ccByToken("cc-name", doc) ?? findByHint(CC_NAME_RE, undefined, false, doc);
	const expMonth =
		ccByToken("cc-exp-month", doc) ?? findByHint(CC_EXP_MONTH_RE, undefined, false, doc);
	const expYear =
		ccByToken("cc-exp-year", doc) ?? findByHint(CC_EXP_YEAR_RE, undefined, false, doc);
	const expCombined =
		!expMonth && !expYear
			? (ccByToken("cc-exp", doc) ?? findByHint(CC_EXP_RE, /month|year/i, false, doc))
			: null;
	const cvv = ccByToken("cc-csc", doc) ?? findByHint(CC_CSC_RE, undefined, true, doc);
	return { number, name, expCombined, expMonth, expYear, cvv };
}

export function cardFieldsPresent(c: CardFields): boolean {
	return !!(c.number || c.cvv || c.expCombined || c.expMonth || c.expYear);
}

export function isCardField(c: CardFields, el: HTMLInputElement): boolean {
	return (
		el === c.number ||
		el === c.name ||
		el === c.expCombined ||
		el === c.expMonth ||
		el === c.expYear ||
		el === c.cvv
	);
}


export const OTP_HINT_RE =
	/one.?time|\botp\b|2fa|mfa|two.?factor|authenticator|auth.?code|login.?code|verif(y|ication).?code|confirmation.?code|passcode|\btotp\b|6.?digit/i;
// case.
export const OTP_NEGATIVE_RE = /card|coupon|promo|postal|\bzip\b|country|address|phone/i;

export function segmentedSiblings(seed: HTMLInputElement): HTMLInputElement[] {
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

export function otpInputs(doc: Document = document): HTMLInputElement[] {
	const tokened = Array.from(
		doc.querySelectorAll<HTMLInputElement>(
			'input[autocomplete~="one-time-code"]:not([readonly]):not([disabled])',
		),
	);
	if (tokened.length >= 1) return tokened;

	const card = detectCardFields(doc);
	let hinted: HTMLInputElement | null = null;
	for (const el of doc.querySelectorAll<HTMLInputElement>(
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
		const lbl = labelText(el, doc);
		if (lbl && !OTP_NEGATIVE_RE.test(lbl) && OTP_HINT_RE.test(lbl)) {
			hinted = el;
			break;
		}
	}
	if (!hinted) return [];
	if (hinted.maxLength === 1) {
		const group = segmentedSiblings(hinted);
		if (group.length >= 2) return group;
	}
	return [hinted];
}


export const CAPTCHA_SELECTORS = [
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

export function isRendered(el: Element): boolean {
	const rect = el.getBoundingClientRect();
	if (rect.width < 10 || rect.height < 10) return false;
	const view = el.ownerDocument?.defaultView;
	const style = view?.getComputedStyle?.(el);
	if (!style) return true;
	return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

export function hasInteractiveCaptcha(doc: Document = document): boolean {
	for (const sel of CAPTCHA_SELECTORS) {
		for (const el of doc.querySelectorAll(sel)) {
			if (isRendered(el)) return true;
		}
	}
	return false;
}


export interface FieldMatcher {
	canonical: string;
	hyphen: string;
}

export function deriveMatcher(key: string): FieldMatcher | null {
	const words = key.toLowerCase().match(/[a-z0-9]+/g);
	if (!words || words.length === 0) return null;
	return { canonical: words.join(""), hyphen: words.join("-") };
}

export const CUSTOM_FILLABLE_TYPES = new Set(["text", "tel", "number", "search", "url", ""]);

export function getFillableInputs(doc: Document = document): HTMLInputElement[] {
	const out: HTMLInputElement[] = [];
	for (const el of doc.querySelectorAll<HTMLInputElement>("input")) {
		if (el.readOnly || el.disabled) continue;
		if (!CUSTOM_FILLABLE_TYPES.has(el.type)) continue;
		out.push(el);
	}
	return out;
}

export function matchesField(el: HTMLInputElement, m: FieldMatcher): boolean {
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
		if (a === m.canonical) return true;
		if (m.canonical.length >= 5 && a.includes(m.canonical)) return true;
	}
	return false;
}


export function candidateKind(
	el: EventTarget | null,
	doc: Document = document,
): "login" | "card" | "otp" | null {
	if (!(el instanceof HTMLInputElement)) return null;
	if (el.readOnly || el.disabled) return null;
	const card = detectCardFields(doc);
	const isCard = cardFieldsPresent(card) && isCardField(card, el);
	if (isCard && el === card.cvv && el.type === "password") return "card";
	const login = detectLoginFields(doc);
	if (el === login.username || el === login.password) return "login";
	if (el.type === "password") return "login";
	if (isCard) return "card";
	if (otpInputs(doc).includes(el)) return "otp";
	return null;
}

export function isAutofillCandidate(
	el: EventTarget | null,
	doc: Document = document,
): el is HTMLInputElement {
	return candidateKind(el, doc) !== null;
}

export function detectLoginFields(doc: Document = document): LoginFields {
	const password = findPasswordField(doc);

	if (password) {
		const near = findUsernameNearPassword(password);
		if (near) return { username: near, password };
	}

	// 2. Explicit autocomplete tokens.
	const explicit = doc.querySelector<HTMLInputElement>(
		'input[autocomplete~="username"]:not([readonly]):not([disabled]), input[autocomplete="email"]:not([readonly]):not([disabled])',
	);
	if (explicit) return { username: explicit, password };

	// 3. A single visible email input.
	const email = doc.querySelector<HTMLInputElement>(
		'input[type="email"]:not([readonly]):not([disabled])',
	);
	if (email) return { username: email, password };

	// 4. Attribute heuristics on text inputs.
	const candidates = doc.querySelectorAll<HTMLInputElement>(USERNAME_TEXT_SELECTOR);
	for (const c of candidates) {
		if (looksLikeUsername(c)) return { username: c, password };
	}
	for (const c of candidates) {
		const lbl = labelText(c, doc);
		if (!lbl || NEGATIVE_HINT_RE.test(lbl)) continue;
		if (USERNAME_HINT_RE.test(lbl)) return { username: c, password };
	}

	return { username: null, password };
}

export function findNewPasswordOnChangeForm(doc: Document = document): HTMLInputElement | null {
	const fields = Array.from(
		doc.querySelectorAll<HTMLInputElement>(
			'input[type="password"]:not([readonly]):not([disabled])',
		),
	);
	if (fields.length < 2) return null;
	const NEW_RE = /new|set/i;
	const OLD_OR_CONFIRM_RE = /old|current|confirm|verify|repeat|re.?type|again/i;
	let candidate: HTMLInputElement | null = null;
	for (const el of fields) {
		const hint = `${el.autocomplete ?? ""} ${attrHint(el)} ${labelText(el, doc) ?? ""}`;
		if (OLD_OR_CONFIRM_RE.test(hint)) continue;
		if (el.autocomplete?.toLowerCase().includes("new-password") || NEW_RE.test(hint)) {
			candidate = el;
			break;
		}
	}
	if (!candidate?.value) return null;
	for (const el of fields) {
		if (el === candidate) continue;
		if (el.value === candidate.value) return candidate;
	}
	return null;
}
