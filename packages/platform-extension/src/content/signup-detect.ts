// Decides whether a focused password field belongs to a flow that SETS a password
// (signup, password reset, forced rotation, change form) so we can offer a
// generated strong password, without firing on ordinary login pages. See
// docs/field-detection.md ("Signup detection").
//
// Design: lean on LANGUAGE-INDEPENDENT structural signals (autocomplete tokens,
// a confirm-password pair, name fields, terms/privacy links, minlength/pattern, a
// strength meter) so non-English pages work without us reading their prose. Human
// text (submit-button / heading keywords) is a booster only, via a small
// multilingual dictionary. Each signal carries a weight; we offer above THRESHOLD.
// A current-password field vetoes outright (login or password-change, not signup).
//
// Setting a password is not the same as creating an account: a reset link and a
// forced rotation both set a password for an account that already exists. The
// score decides whether to OFFER; `isAccountCreationForm` separately decides
// whether the result is a new login or a rotation of the saved one.

import {
	attrHint,
	closestAcrossShadow,
	deepQuery,
	deepQueryAll,
	isRendered,
	labelText,
	USERNAME_HINT_RE,
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
	setPasswordAction: 40, // the form's own submit control says "set/change/reset password"
	createHint: 35, // new/create/choose/confirm hint on the field or its label
	identifiedAccount: 30, // no editable username field: the account is already known
	pwRules: 20, // the field carries a password policy (pattern / minlength / passwordrules)
	strengthMeter: 20, // a strength meter / requirements element in scope
	largeForm: 15, // more than 4 rendered inputs in scope (registration is long)
	loginUrl: -40, // /login, /signin, ... in the path (applied only sans STRONG)
	loginText: -35, // "remember me" / "forgot password" near the form (only sans STRONG)
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

// Multilingual "set a password" keywords, matched against the FORM's own submit
// controls only. Two things keep these safe. Scoping to the form: a login page
// links to "reset password", but a login form's own button never says it. And
// pairing a verb with the noun: a bare "password" would match the "Show password"
// toggle that sits inside plenty of login forms.
const SET_PASSWORD_TERMS = [
	// en
	"set password",
	"set a password",
	"set your password",
	"set new password",
	"create password",
	"create a password",
	"create new password",
	"choose a password",
	"choose password",
	"change password",
	"change your password",
	"update password",
	"reset password",
	"reset your password",
	"save password",
	"new password",
	"confirm password",
	// es
	"cambiar contrase",
	"crear contrase",
	"restablecer contrase",
	"nueva contrase",
	// fr
	"changer le mot de passe",
	"modifier le mot de passe",
	"nouveau mot de passe",
	"réinitialiser le mot de passe",
	"reinitialiser le mot de passe",
	// de
	"passwort ändern",
	"passwort andern",
	"passwort festlegen",
	"passwort erstellen",
	"passwort zurücksetzen",
	"passwort zurucksetzen",
	"neues passwort",
	// nl
	"wachtwoord wijzigen",
	"wachtwoord instellen",
	"nieuw wachtwoord",
	// pt
	"alterar senha",
	"criar senha",
	"redefinir senha",
	"nova senha",
	// it
	"cambia password",
	"modifica password",
	"nuova password",
	// sv
	"nytt lösenord",
	"ändra lösenord",
	// ru
	"изменить пароль",
	"новый пароль",
	// zh
	"新密码",
	"修改密码",
	// ja
	"パスワードを変更",
	"新しいパスワード",
	// ko
	"비밀번호 변경",
	"새 비밀번호",
	// tr
	"şifre değiştir",
	"yeni şifre",
	// pl
	"zmień hasło",
	"nowe hasło",
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

/**
 * Everything a field says about itself: the shared attribute hint plus `title`
 * and its label. `attrHint` deliberately omits `title` (it feeds card and OTP
 * detection too, where tooltips are noise), but on a password field the tooltip
 * is often the only place the intent is written -- Angular Material and friends
 * put "Enter your new password" there while the visible label is just a float.
 */
function fieldHint(el: HTMLInputElement): string {
	return `${attrHint(el)} ${el.title} ${labelText(el)}`;
}

/** True if the field's autocomplete token / hints mark it as the *current* password. */
function isCurrentPassword(el: HTMLInputElement): boolean {
	const ac = el.autocomplete?.toLowerCase() ?? "";
	if (ac.split(/\s+/).includes("current-password")) return true;
	return CURRENT_PASSWORD_RE.test(fieldHint(el));
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

const BUTTON_SELECTOR = 'button, [role="button"], input[type="submit"], input[type="button"]';

/**
 * Everything a control says: its visible text (or `value`, for an input) plus
 * `title` and `aria-label`. Icon buttons and design-system wrappers keep the real
 * label in an attribute, so a submit can render "Continue" while its title says
 * "Change Password".
 */
function controlText(el: HTMLElement): string {
	const text = el instanceof HTMLInputElement ? el.value : (el.textContent ?? "");
	return `${text} ${el.title} ${el.getAttribute("aria-label") ?? ""}`;
}

function collectSignupText(scope: ParentNode, doc: Document): string {
	const parts: string[] = [];
	for (const el of deepQueryAll<HTMLElement>(BUTTON_SELECTOR, scope)) parts.push(controlText(el));
	for (const h of doc.querySelectorAll("h1, h2, legend")) parts.push(h.textContent ?? "");
	parts.push(doc.title);
	return parts.join(" ").toLowerCase();
}

/**
 * True if a submit control in the form says "set/change/reset a password". Unlike
 * `collectSignupText` this never leaves the form: page headings and the title
 * describe the shell, and a login page's shell says "password" constantly.
 */
function hasSetPasswordAction(scope: ParentNode): boolean {
	for (const el of deepQueryAll<HTMLElement>(BUTTON_SELECTOR, scope)) {
		const hay = controlText(el).toLowerCase();
		if (SET_PASSWORD_TERMS.some((term) => hay.includes(term))) return true;
	}
	return false;
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

/**
 * True if the element is parked outside the document, the `left:-9999px` idiom for
 * hiding a field from sight while keeping it in the form. `isRendered` can't see
 * this: the box has real dimensions and is neither `display:none` nor transparent.
 * Compared in DOCUMENT coordinates, so a field merely scrolled out of view (whose
 * viewport rect is also negative) is still counted as on-screen.
 */
function isOffscreen(el: Element): boolean {
	const rect = el.getBoundingClientRect();
	const view = el.ownerDocument?.defaultView;
	const x = rect.left + (view?.scrollX ?? 0);
	const y = rect.top + (view?.scrollY ?? 0);
	return x + rect.width <= 0 || y + rect.height <= 0;
}

/**
 * True if the form has no username field the user could still fill in: absent, or
 * present but hidden / readonly / already populated.
 *
 * This is what separates SETTING a password from CREATING an account. A signup
 * form asks for the identifier; a reset link, a forced rotation and a change form
 * already know who you are, so the identifier is either gone, readonly, or --
 * following the WHATWG guidance that lets password managers associate the
 * credential -- parked off-screen with `position:absolute; left:-9999px`.
 */
function hasIdentifiedAccount(scope: ParentNode): boolean {
	for (const el of deepQueryAll<HTMLInputElement>("input", scope)) {
		if (el.type === "hidden" || el.type === "password") continue;
		// Deliberately not keyed on `value`: a signup form's email is populated the
		// moment the user types it, and that must not reclassify the form.
		if (el.readOnly || el.disabled) continue;
		if (!isRendered(el) || isOffscreen(el)) continue;
		const ac = (el.autocomplete?.toLowerCase() ?? "").split(/\s+/);
		const looksLikeUsername =
			el.type === "email" ||
			ac.includes("username") ||
			ac.includes("email") ||
			USERNAME_HINT_RE.test(attrHint(el));
		if (looksLikeUsername) return false;
	}
	return true;
}

/** True if the field advertises a password policy: a pattern, a minimum, or Safari's `passwordrules`. */
function hasPasswordPolicy(field: HTMLInputElement): boolean {
	if (field.hasAttribute("pattern") || field.hasAttribute("passwordrules")) return true;
	return field.minLength >= 8;
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

	const hay = collectSignupText(scope, doc);
	if (SIGNUP_TERMS.some((t) => hay.includes(t))) add(WEIGHTS.signupText, "signup-text");
	if (form && hasSetPasswordAction(form)) add(WEIGHTS.setPasswordAction, "set-password-action");

	if (CREATE_HINT_RE.test(fieldHint(field))) add(WEIGHTS.createHint, "create-hint");
	if (form && hasIdentifiedAccount(form)) add(WEIGHTS.identifiedAccount, "identified-account");
	if (hasPasswordPolicy(field)) add(WEIGHTS.pwRules, "pw-rules");
	if (hasStrengthMeter(field, scope)) add(WEIGHTS.strengthMeter, "strength-meter");
	if (countRenderedInputs(scope) > 4) add(WEIGHTS.largeForm, "large-form");

	// The negatives describe the PAGE (its route, its surrounding prose), so a STRONG
	// structural signal about the FORM overrules them: a rendered confirm pair means
	// two password boxes to set, and no login form has ever had two. Without that proof
	// they still apply, which is what keeps us off an ordinary /login page. Same carve-out
	// as the returning-user damper below, and for the same reason: a reset link commonly
	// lands on /auth/... under a heading that says "forgot password".
	const structural = strongToken || confirmPair || changeForm;
	if (!structural) {
		if (LOGIN_URL_RE.test(path)) add(WEIGHTS.loginUrl, "login-url");
		if (LOGIN_TERMS.some((t) => hay.includes(t))) add(WEIGHTS.loginText, "login-text");
	}

	// Returning-user damper: don't nag when the site already has saved logins,
	// unless a STRONG structural signal makes account creation / rotation unambiguous.
	if (opts.hasExistingLogins && !structural) add(WEIGHTS.returningUser, "returning-user");

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
 * True if `field` is the new-password field of a form that creates an ACCOUNT, not one
 * that merely sets a password on an account that already exists (a reset link, a forced
 * rotation, a change form). Unlike `shouldSuggestPassword` this ignores whether the field
 * is empty, so a capture can be classified at submit time.
 *
 * The caller uses this to force a fresh save past dedupe, because signing up a second time
 * on a site you already have a login for really is a new credential. Setting a password is
 * not: routing it through dedupe offers "Update" when a saved login matches and "Save" when
 * none does, which is right either way -- and the update prompt still has "Save as new".
 */
export function isAccountCreationForm(field: HTMLInputElement): boolean {
	if (field.type !== "password") return false;
	if (isPasswordChangeForm(field)) return false;
	const form = scopeFormOf(field);
	// An identified account is one we could already have saved; only a form that still
	// asks for the identifier is creating one.
	if (form && hasIdentifiedAccount(form)) return false;
	const { score, veto } = scoreSignupForm(field);
	return !veto && score >= THRESHOLD;
}

/**
 * The email slice of the identifier vocabulary. Deliberately NOT `USERNAME_HINT_RE`, which
 * also carries "account" and "user": pairing an account-number box with an email box is not
 * a signup, and the pair below is load-bearing.
 */
const EMAIL_HINT_RE =
	/\be.?mail\b|\bmail\b|courriel|correo|mejl|s(ä|a)hk(ö|o)posti|posta.?elettronica|e.?posta|почта|メール|邮箱|이메일/i;

/** True if the box asks for an email: by type, by token, or by what it says about itself. */
function looksLikeEmail(el: HTMLInputElement): boolean {
	if (el.type === "email") return true;
	if ((el.autocomplete?.toLowerCase() ?? "").split(/\s+/).includes("email")) return true;
	return EMAIL_HINT_RE.test(`${attrHint(el)} ${labelText(el)}`);
}

/**
 * True if `scope` asks for the email TWICE. Structural and language-independent, like the
 * confirm-password pair, and decisive for the same reason: a login form asks who you are
 * once, and so does the email screen of a two-step login. Only a form making an account
 * has you type it twice.
 */
function hasConfirmEmailPair(scope: ParentNode): boolean {
	let found = 0;
	for (const el of deepQueryAll<HTMLInputElement>("input", scope)) {
		if (el.type === "hidden" || el.type === "password") continue;
		if (el.readOnly || el.disabled) continue;
		if (!isRendered(el) || isOffscreen(el)) continue;
		if (!looksLikeEmail(el)) continue;
		if (++found >= 2) return true;
	}
	return false;
}

/**
 * True if `field` sits on a form that creates an account. `isAccountCreationForm` answers for
 * the password field itself; its NEIGHBOURS need the same answer and cannot give it, since
 * there is nothing in an email box that says "signup" - and the picker has no business on one
 * either way, because the user is inventing a credential there rather than filling one.
 */
export function isOnAccountCreationForm(field: HTMLInputElement): boolean {
	const scope: ParentNode = scopeFormOf(field) ?? field.ownerDocument;
	const passwords = deepQueryAll<HTMLInputElement>(
		'input[type="password"]:not([readonly]):not([disabled])',
		scope,
	).filter(isRendered);
	// A current-password box says the account already exists: a login form, or a change form.
	if (passwords.some(isCurrentPassword)) return false;
	if (passwords.some(isAccountCreationForm)) return true;
	// No password box in reach: a signup split across steps, which invents the credential on
	// the NEXT screen. Only the confirm-email pair is decisive enough to act on here. The
	// page-level signals - a /register route, a "Create account" heading - cannot tell a
	// signup's email step from a two-step LOGIN's, and getting that wrong would silently kill
	// autofill on the screen where it is worth the most.
	return hasConfirmEmailPair(scope);
}
