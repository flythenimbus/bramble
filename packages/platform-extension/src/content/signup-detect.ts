// Decides whether a focused password field belongs to an account-creation flow
// (signup / password-reset) so we can offer a generated strong password, without
// firing on ordinary login pages. See docs/field-detection.md ("Signup detection").
//
// Design: lean on LANGUAGE-INDEPENDENT structural signals (autocomplete tokens,
// a confirm-password pair, name fields, terms/privacy links, minlength/pattern, a
// strength meter) so non-English pages work without us reading their prose. Human
// text (submit-button / heading keywords) is a booster only, via a small
// multilingual dictionary. Each signal carries a weight; we offer above THRESHOLD.
// A current-password field vetoes outright (login or password-change, not signup).

import {
	attrHint,
	closestAcrossShadow,
	deepQuery,
	deepQueryAll,
	isRendered,
	labelText,
} from "./detection";

// --- Signal weights (tune here). Either STRONG signal alone reaches THRESHOLD. ---
export const WEIGHTS = {
	newPasswordToken: 100, // autocomplete="new-password" on the focused field
	confirmPair: 100, // 2+ non-current password fields in scope
	changeForm: 100, // a current-password sibling (focused field is the new password)
	tosLink: 40, // terms/privacy link or agree checkbox in the form
	nameField: 30, // given-name / family-name / name input in scope
	signupUrl: 40, // /signup, /register, /join, ... in the path
	signupText: 40, // signup keyword on a submit button / heading / title
	createHint: 35, // new/create/choose/confirm hint on the field or its label
	pwRules: 20, // the field has a pattern or minlength >= 8
	strengthMeter: 20, // a strength meter / requirements element in scope
	largeForm: 15, // more than 4 rendered inputs in scope (registration is long)
	loginUrl: -40, // /login, /signin, ... in the path
	loginText: -35, // "remember me" / "forgot password" near the form
	returningUser: -40, // saved logins already exist here (applied only sans STRONG)
} as const;

export const THRESHOLD = 100;

// --- Attribute / label hint patterns (English; boosters only, never load-bearing) ---
const CURRENT_PASSWORD_RE = /current.?password|old.?password|existing.?password/i;
const CREATE_HINT_RE =
	/new.?password|create.?password|set.?(a.?)?password|choose.?(a.?)?password|confirm.?password|repeat.?password|re.?enter.?password|re.?type.?password/i;
const NAME_HINT_RE = /first.?name|last.?name|full.?name|given.?name|family.?name/i;

// --- URL path patterns. Mostly English even on localized sites, so path-safe. ---
const SIGNUP_URL_RE =
	/sign[_-]?up|regist(er|ration|ro|rieren)|\/join\b|create[_-]?account|new[_-]?account|inscription|cadastr|kayit/i;
const LOGIN_URL_RE = /log[_-]?in|sign[_-]?in|\/auth\b|\/session|anmelden|connexion/i;

// --- href / link-text patterns for the terms-of-service signal (language-agnostic) ---
const TOS_HREF_RE =
	/terms|privacy|\btos\b|eula|conditions|datenschutz|confidential|privacidad|informativa/i;

// Multilingual signup keywords (submit button / heading / title). Lowercased,
// substring-matched. CJK entries have no word boundaries, so substring is correct.
// Ambiguous words (German "anmelden", Dutch "aanmelden" = login) are excluded.
const SIGNUP_TERMS = [
	"sign up",
	"signup",
	"register",
	"registration",
	"create account",
	"create an account",
	"create your account",
	"get started",
	"join now",
	"join free",
	"crear cuenta",
	"crea tu cuenta",
	"regístrate",
	"registrate",
	"registrarse",
	"s'inscrire",
	"inscription",
	"créer un compte",
	"registrieren",
	"konto erstellen",
	"registrati",
	"iscriviti",
	"crea account",
	"cadastre-se",
	"criar conta",
	"cadastro",
	"registreren",
	"account aanmaken",
	"регистрация",
	"зарегистрироваться",
	"создать аккаунт",
	"注册",
	"创建账户",
	"創建帳戶",
	"新規登録",
	"アカウント作成",
	"会員登録",
	"회원가입",
	"가입하기",
	"계정 만들기",
	"kayıt ol",
	"hesap oluştur",
	"zarejestruj",
	"załóż konto",
];

// Login-only phrases; safe as a negative because they rarely appear on signup
// forms (unlike "sign in", which shows up as an "already have an account?" link).
const LOGIN_TERMS = [
	"remember me",
	"forgot password",
	"forgot your password",
	"mot de passe oublié",
	"passwort vergessen",
	"contraseña olvidada",
	"olvidaste tu contraseña",
	"esqueceu a senha",
	"password dimenticata",
];

/** True if the field's autocomplete token / hints mark it as the *current* password. */
function isCurrentPassword(el: HTMLInputElement): boolean {
	const ac = el.autocomplete?.toLowerCase() ?? "";
	if (ac.split(/\s+/).includes("current-password")) return true;
	return CURRENT_PASSWORD_RE.test(`${attrHint(el)} ${labelText(el)}`);
}

/** True if the field's autocomplete token marks it as a *new* password. */
function isNewPasswordToken(el: HTMLInputElement): boolean {
	return (el.autocomplete?.toLowerCase() ?? "").split(/\s+/).includes("new-password");
}

/** The form the field lives in (crossing shadow boundaries), or null for a lone field. */
function scopeFormOf(field: HTMLInputElement): Element | null {
	return closestAcrossShadow(field, "form");
}

/** Rendered, editable password inputs in scope that aren't the *current* password. */
export function signupPasswordFields(field: HTMLInputElement): HTMLInputElement[] {
	const scope: ParentNode = scopeFormOf(field) ?? field.ownerDocument;
	const all = deepQueryAll<HTMLInputElement>(
		'input[type="password"]:not([readonly]):not([disabled])',
		scope,
	).filter((el) => isRendered(el) && !isCurrentPassword(el));
	// The focused field is always a target even if isRendered momentarily disagrees.
	if (!all.includes(field)) all.unshift(field);
	return all;
}

function collectSignupText(scope: ParentNode, doc: Document): string {
	const parts: string[] = [];
	for (const el of deepQueryAll<HTMLElement>(
		'button, [role="button"], input[type="submit"], input[type="button"]',
		scope,
	)) {
		if (el instanceof HTMLInputElement) parts.push(el.value);
		else parts.push(el.textContent ?? "");
	}
	for (const h of doc.querySelectorAll("h1, h2, legend")) parts.push(h.textContent ?? "");
	parts.push(doc.title);
	return parts.join(" ").toLowerCase();
}

/** True if any terms-of-service / privacy link or agree checkbox sits in the form. */
function hasTermsSignal(scope: ParentNode): boolean {
	for (const a of deepQueryAll<HTMLAnchorElement>("a[href]", scope)) {
		const href = a.getAttribute("href") ?? "";
		if (TOS_HREF_RE.test(href) || TOS_HREF_RE.test(a.textContent ?? "")) return true;
	}
	// A checkbox whose accessible label mentions terms/privacy (common consent gate).
	for (const cb of deepQueryAll<HTMLInputElement>('input[type="checkbox"]', scope)) {
		if (TOS_HREF_RE.test(`${attrHint(cb)} ${labelText(cb)}`)) return true;
	}
	return false;
}

/** True if scope carries a name field (given/family/full name), a login form never does. */
function hasNameField(scope: ParentNode): boolean {
	if (
		deepQuery(
			'input[autocomplete~="given-name"], input[autocomplete~="family-name"], input[autocomplete~="name"]',
			scope,
		)
	) {
		return true;
	}
	for (const el of deepQueryAll<HTMLInputElement>(
		'input[type="text"]:not([readonly]):not([disabled]), input:not([type]):not([readonly]):not([disabled])',
		scope,
	)) {
		if (NAME_HINT_RE.test(`${attrHint(el)} ${labelText(el)}`)) return true;
	}
	return false;
}

/** True if scope shows a password strength meter or requirements element. */
function hasStrengthMeter(field: HTMLInputElement, scope: ParentNode): boolean {
	if (field.getAttribute("aria-describedby")) return true;
	return !!deepQuery('meter, [role="progressbar"], [role="meter"]', scope);
}

function countRenderedInputs(scope: ParentNode): number {
	let n = 0;
	for (const el of deepQueryAll<HTMLInputElement>("input", scope)) {
		if (el.type === "hidden") continue;
		if (isRendered(el)) n++;
	}
	return n;
}

export interface SignupScore {
	score: number;
	veto: boolean;
	signals: string[];
}

/** Full breakdown of the signup score for `field`. `shouldSuggestPassword` wraps this. */
export function scoreSignupForm(
	field: HTMLInputElement,
	opts: { hasExistingLogins?: boolean } = {},
): SignupScore {
	const doc = field.ownerDocument;
	const form = scopeFormOf(field);
	const scope: ParentNode = form ?? doc;
	const signals: string[] = [];

	// Veto only when the FOCUSED field is the current password: a login field, or the
	// "old password" box on a change form. A current-password SIBLING is not a veto; it
	// marks this (non-current) field as a change form's new-password field (handled below).
	if (isCurrentPassword(field)) return { score: 0, veto: true, signals: ["veto:current"] };
	const scopePws = deepQueryAll<HTMLInputElement>(
		'input[type="password"]:not([readonly]):not([disabled])',
		scope,
	).filter(isRendered);

	let score = 0;
	const add = (weight: number, name: string): void => {
		score += weight;
		signals.push(name);
	};

	const strongToken = isNewPasswordToken(field);
	if (strongToken) add(WEIGHTS.newPasswordToken, "new-password-token");

	const newPws = scopePws.filter((el) => !isCurrentPassword(el));
	const confirmPair = newPws.length >= 2;
	if (confirmPair) add(WEIGHTS.confirmPair, "confirm-pair");

	// A current-password sibling in the same form (the focused field is not it) means we're
	// on a change form and this is the new-password field: offer a strong password to rotate to.
	const changeForm = !!form && scopePws.some(isCurrentPassword);
	if (changeForm) add(WEIGHTS.changeForm, "change-form");

	if (hasTermsSignal(scope)) add(WEIGHTS.tosLink, "terms-link");
	if (hasNameField(scope)) add(WEIGHTS.nameField, "name-field");

	const path = `${location.pathname}${location.search}`;
	if (SIGNUP_URL_RE.test(path)) add(WEIGHTS.signupUrl, "signup-url");
	if (LOGIN_URL_RE.test(path)) add(WEIGHTS.loginUrl, "login-url");

	const hay = collectSignupText(scope, doc);
	if (SIGNUP_TERMS.some((t) => hay.includes(t))) add(WEIGHTS.signupText, "signup-text");
	if (LOGIN_TERMS.some((t) => hay.includes(t))) add(WEIGHTS.loginText, "login-text");

	if (CREATE_HINT_RE.test(`${attrHint(field)} ${labelText(field)}`)) {
		add(WEIGHTS.createHint, "create-hint");
	}
	if (field.hasAttribute("pattern") || field.minLength >= 8) add(WEIGHTS.pwRules, "pw-rules");
	if (hasStrengthMeter(field, scope)) add(WEIGHTS.strengthMeter, "strength-meter");
	if (countRenderedInputs(scope) > 4) add(WEIGHTS.largeForm, "large-form");

	// Returning-user damper: don't nag when the site already has saved logins,
	// unless a STRONG structural signal makes account creation / rotation unambiguous.
	if (opts.hasExistingLogins && !strongToken && !confirmPair && !changeForm) {
		add(WEIGHTS.returningUser, "returning-user");
	}

	return { score, veto: false, signals };
}

/** True when we should offer a generated password on this password field. */
export function shouldSuggestPassword(
	field: HTMLInputElement,
	opts: { hasExistingLogins?: boolean } = {},
): boolean {
	// Only ever suggest into an empty password field; if the user is typing their
	// own, get out of the way.
	if (field.type !== "password" || field.value) return false;
	const { score, veto } = scoreSignupForm(field, opts);
	return !veto && score >= THRESHOLD;
}

/**
 * True if `field`'s form has a rendered current-password sibling: a password-change
 * (rotation of an existing login), not a signup. Used to decide save-new vs update.
 */
export function isPasswordChangeForm(field: HTMLInputElement): boolean {
	const form = scopeFormOf(field);
	if (!form) return false;
	return deepQueryAll<HTMLInputElement>(
		'input[type="password"]:not([readonly]):not([disabled])',
		form,
	).some((el) => el !== field && isRendered(el) && isCurrentPassword(el));
}

/**
 * True if `field` is the new-password field of an account-creation form (signup / reset),
 * not a login or a password-change form. Unlike `shouldSuggestPassword` this ignores whether
 * the field is empty, so a capture can be classified at submit time.
 */
export function isAccountCreationForm(field: HTMLInputElement): boolean {
	if (field.type !== "password") return false;
	if (isPasswordChangeForm(field)) return false;
	const { score, veto } = scoreSignupForm(field);
	return !veto && score >= THRESHOLD;
}
