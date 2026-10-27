/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isAccountCreationForm,
	isOnAccountCreationForm,
	isPasswordChangeForm,
	scoreSignupForm,
	shouldSuggestAlias,
	shouldSuggestPassword,
	signupPasswordFields,
} from "./signup-detect";

function loadHTML(html: string): void {
	document.body.innerHTML = html;
}

/** The nth password field (0-indexed) in the document. */
function pw(n = 0): HTMLInputElement {
	return document.querySelectorAll<HTMLInputElement>('input[type="password"]')[n]!;
}

function path(p: string): void {
	window.history.replaceState({}, "", p);
}

beforeEach(() => {
	document.body.innerHTML = "";
	path("/");
	// jsdom does no layout, so every getBoundingClientRect is 0x0 and isRendered()
	// would reject all fields. Give elements a real box so visibility gating works;
	// display:none is still caught via getComputedStyle, exercised below.
	vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
		width: 200,
		height: 24,
		top: 0,
		left: 0,
		right: 200,
		bottom: 24,
		x: 0,
		y: 0,
		toJSON: () => ({}),
	} as DOMRect);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("shouldSuggestPassword — offers on account creation", () => {
	it("offers on a new-password autocomplete token alone (GitHub-style)", () => {
		loadHTML(`
			<form>
				<input type="email" name="email" autocomplete="email" />
				<input type="password" name="password" autocomplete="new-password" />
				<button type="submit">Continue</button>
			</form>
		`);
		expect(shouldSuggestPassword(pw())).toBe(true);
	});

	it("offers on a password + confirm pair with no other signal", () => {
		loadHTML(`
			<form>
				<input type="password" name="p1" />
				<input type="password" name="p2" />
				<button type="submit">Continue</button>
			</form>
		`);
		expect(shouldSuggestPassword(pw(0))).toBe(true);
	});

	it("offers on a reset-password form (new + confirm, no current)", () => {
		path("/account/reset");
		loadHTML(`
			<form>
				<input type="password" name="new" />
				<input type="password" name="confirm" />
			</form>
		`);
		expect(shouldSuggestPassword(pw(0))).toBe(true);
	});

	it("offers on the new-password field of a change form (current + new + confirm)", () => {
		loadHTML(`
			<form>
				<input type="password" name="current" autocomplete="current-password" />
				<input type="password" name="new" autocomplete="new-password" />
				<input type="password" name="confirm" />
			</form>
		`);
		// The current-password sibling marks the new field as a rotation target, even for
		// a returning user (they have a saved login for the site).
		expect(shouldSuggestPassword(pw(1), { hasExistingLogins: true })).toBe(true);
	});

	it("offers on a token-less two-field change form (old + new, no confirm)", () => {
		loadHTML(`
			<form>
				<input type="password" name="oldpass" placeholder="Current password" />
				<input type="password" name="newpass" placeholder="New password" />
			</form>
		`);
		// Field 0 is "Current password" (hint), field 1 is the new one. The change-form
		// signal carries it past the threshold with no autocomplete tokens.
		expect(shouldSuggestPassword(pw(1), { hasExistingLogins: true })).toBe(true);
	});

	it("offers on a non-English signup via structural signals only (no keywords)", () => {
		// German path + name field + privacy link + minlength: no English text needed.
		path("/registrieren");
		loadHTML(`
			<form>
				<input type="text" autocomplete="given-name" />
				<input type="text" autocomplete="family-name" />
				<input type="email" />
				<input type="password" name="passwort" minlength="10" />
				<a href="/datenschutz">Datenschutz</a>
			</form>
		`);
		expect(shouldSuggestPassword(pw())).toBe(true);
	});
});

describe("shouldSuggestPassword — declines on login and edge cases", () => {
	it("vetoes on a current-password login field", () => {
		loadHTML(`
			<form>
				<input type="email" autocomplete="username" />
				<input type="password" autocomplete="current-password" />
			</form>
		`);
		expect(shouldSuggestPassword(pw())).toBe(false);
	});

	it("declines on a bare login form (login URL + forgot/remember, no positives)", () => {
		path("/login");
		loadHTML(`
			<form>
				<input type="email" />
				<input type="password" name="password" />
				<label><input type="checkbox" /> Remember me</label>
				<a href="/reset">Forgot password?</a>
				<button type="submit">Sign in</button>
			</form>
		`);
		expect(shouldSuggestPassword(pw())).toBe(false);
	});

	it("still vetoes the old-password field of a change form", () => {
		loadHTML(`
			<form>
				<input type="password" name="current" autocomplete="current-password" />
				<input type="password" name="new" autocomplete="new-password" />
				<input type="password" name="confirm" />
			</form>
		`);
		// Focused on the current-password ("old") field: never suggest into it.
		expect(shouldSuggestPassword(pw(0))).toBe(false);
	});

	it("declines on an ambiguous single-password form with no signals", () => {
		loadHTML(`
			<form>
				<input type="text" name="user" />
				<input type="password" name="password" />
			</form>
		`);
		expect(shouldSuggestPassword(pw())).toBe(false);
	});

	it("declines once the user has typed their own password", () => {
		loadHTML(`
			<form>
				<input type="password" autocomplete="new-password" />
				<input type="password" name="confirm" />
			</form>
		`);
		pw().value = "hunter2";
		expect(shouldSuggestPassword(pw())).toBe(false);
	});

	it("declines on a non-password field", () => {
		loadHTML(`<form><input type="email" autocomplete="new-password" /></form>`);
		const email = document.querySelector<HTMLInputElement>('input[type="email"]')!;
		expect(shouldSuggestPassword(email)).toBe(false);
	});

	it("ignores a display:none honeypot when counting the confirm pair", () => {
		loadHTML(`
			<form>
				<input type="text" name="user" />
				<input type="password" name="password" />
				<input type="password" name="hp" style="display:none" />
				<a href="/reset">Forgot password?</a>
				<button type="submit">Sign in</button>
			</form>
		`);
		// The only visible password field is the login one; the hidden honeypot must
		// not fabricate a confirm pair.
		expect(shouldSuggestPassword(pw(0))).toBe(false);
	});
});

// Verbatim from a utility-billing login (JSP, Bootstrap), which sets
// autocomplete="new-password" on its LOGIN password box: a widespread hack to stop browsers
// offering the saved password. Reported as "this form isn't offering autofill", and it was not:
// the token scored 100, matched CREATE_HINT_RE's own `new.?password` for another 35, and counted
// as structural, which skipped the -35 for "Remember me" and the -40 for the saved login. 135
// against a threshold of 100, so the picker showed a generated password and hid the credential.
const LYING_LOGIN_FORM = `
	<form id="login-form" name="login" method="post" action="/app/capricorn?para=index">
		<input type="hidden" name="jspCSRFToken" value="659a14aa" />
		<label for="accessCode">Email Address</label>
		<input type="text" class="form-control" id="accessCode" name="accessCode"
			autocorrect="off" autocapitalize="none" placeholder="Email Address" />
		<label for="password">Password</label>
		<input type="password" class="form-control" id="password" name="password" maxlength="60"
			placeholder="Password" autocomplete="new-password" />
		<button type="submit" id="login_btn">Login</button>
		<label><input type="checkbox" name="rememberMyAccountNumber" value="Y" /> Remember me</label>
		<a href="/app/forgotPassword.jsp">Reset your password?</a>
		<a href="/app/forgotAccessCode.jsp">Reset your User Name?</a>
		<input type="hidden" name="nextPara" value="" />
	</form>`;

describe("a login form that claims autocomplete=new-password", () => {
	it("does not hide the saved login behind a generated one", () => {
		loadHTML(LYING_LOGIN_FORM);
		expect(shouldSuggestPassword(pw(), { hasExistingLogins: true })).toBe(false);
	});

	it("is not a signup even for a first-time visitor", () => {
		// "Remember me" alone has to carry this one, since there is no saved login to damp with.
		loadHTML(LYING_LOGIN_FORM);
		expect(shouldSuggestPassword(pw(), { hasExistingLogins: false })).toBe(false);
	});

	it("reads 'Remember me' out of the checkbox label that holds it", () => {
		// The login evidence on this form is a checkbox label and two links, none of which
		// collectSignupText looks at. Without them the token alone still clears THRESHOLD.
		loadHTML(LYING_LOGIN_FORM);
		expect(scoreSignupForm(pw()).signals).toContain("login-text");
	});

	it("does not read a login form's 'Create an account' link as signup evidence", () => {
		// The other direction of the same asymmetry: links are read for the negatives only.
		loadHTML(`
			<form>
				<input type="email" />
				<input type="password" name="password" />
				<a href="/register">Create an account</a>
				<button type="submit">Sign in</button>
			</form>
		`);
		expect(scoreSignupForm(pw()).signals).not.toContain("signup-text");
		expect(shouldSuggestPassword(pw())).toBe(false);
	});

	it("counts the token once, not twice", () => {
		loadHTML(LYING_LOGIN_FORM);
		const { signals } = scoreSignupForm(pw());
		expect(signals).toContain("new-password-token");
		expect(signals).not.toContain("create-hint");
	});

	it("still reads a create hint the field writes in prose", () => {
		// Only the token is discounted. A name or a label that says it is a new password counts.
		loadHTML(`
			<form>
				<label for="p">Choose a password</label>
				<input type="password" id="p" name="p" autocomplete="new-password" />
			</form>
		`);
		expect(scoreSignupForm(pw()).signals).toContain("create-hint");
	});
});

describe("shouldSuggestPassword — set-password forms (reset / rotation)", () => {
	it("offers on a confirm pair even under a login route", () => {
		// A reset link commonly lands under /auth or /login. Two rendered non-current
		// password boxes are structural proof this isn't the login form the route names.
		path("/auth/reset-password");
		loadHTML(`
			<form autocomplete="off">
				<input type="password" id="newPassword" name="password" />
				<input type="password" id="confirmPassword" name="confirm password" />
				<button type="submit">Continue</button>
			</form>
		`);
		expect(shouldSuggestPassword(pw(0))).toBe(true);
	});

	it("offers on a confirm pair under a 'forgot password' heading", () => {
		document.title = "Forgot password";
		loadHTML(`
			<h1>Forgot your password?</h1>
			<form>
				<input type="password" name="new" />
				<input type="password" name="confirm" />
			</form>
		`);
		expect(shouldSuggestPassword(pw(0))).toBe(true);
		document.title = "";
	});

	it("reads the intent out of the field's title when the visible label is a float", () => {
		// Angular Material and friends put the intent in the tooltip, not the label.
		path("/portal/security");
		loadHTML(`
			<form>
				<input type="password" id="pw" name="password" title="Enter your new password" />
				<button type="submit" title="Change Password">Continue</button>
			</form>
		`);
		const { signals } = scoreSignupForm(pw());
		expect(signals).toEqual(expect.arrayContaining(["create-hint", "set-password-action"]));
		expect(shouldSuggestPassword(pw())).toBe(true);
	});

	it("scores an off-screen username companion as an identified account", () => {
		loadHTML(`
			<form>
				<div id="hidden-user"><input type="email" name="username" autocomplete="username" /></div>
				<input type="password" name="password" title="Enter your new password" />
			</form>
		`);
		// Only the wrapper is parked off-screen; isRendered() can't see that, so the rect
		// for the username input has to say so.
		const user = document.querySelector<HTMLInputElement>('input[name="username"]')!;
		vi.spyOn(user, "getBoundingClientRect").mockReturnValue({
			width: 200,
			height: 24,
			top: 0,
			left: -9999,
			right: -9799,
			bottom: 24,
			x: -9999,
			y: 0,
			toJSON: () => ({}),
		} as DOMRect);
		expect(scoreSignupForm(pw()).signals).toContain("identified-account");
	});

	it("does not call a visible username field an identified account", () => {
		loadHTML(`
			<form>
				<input type="email" name="username" autocomplete="username" />
				<input type="password" name="password" />
			</form>
		`);
		expect(scoreSignupForm(pw()).signals).not.toContain("identified-account");
	});

	it("declines on a login form whose only 'password' text is a show-password toggle", () => {
		path("/login");
		loadHTML(`
			<form>
				<input type="email" name="email" />
				<input type="password" name="password" />
				<button type="button" title="Show password" aria-label="Show password"></button>
				<button type="submit">Sign in</button>
			</form>
		`);
		expect(shouldSuggestPassword(pw())).toBe(false);
	});

	it("declines on a login form under a login route with a hidden username", () => {
		// The password step of a two-step login: identified account, one password box.
		path("/login/password");
		loadHTML(`
			<form>
				<input type="email" name="username" autocomplete="username" readonly value="me@example.com" />
				<input type="password" name="password" />
				<button type="submit">Sign in</button>
			</form>
		`);
		expect(shouldSuggestPassword(pw())).toBe(false);
	});

	it("counts Safari's passwordrules as a password policy", () => {
		loadHTML(`
			<form>
				<input type="password" name="password" passwordrules="minlength: 15; allowed: unicode;" />
			</form>
		`);
		expect(scoreSignupForm(pw()).signals).toContain("pw-rules");
	});
});

describe("returning-user damper", () => {
	const weakSignupForm = `
		<form>
			<input type="text" autocomplete="given-name" />
			<input type="email" />
			<input type="password" name="password" />
			<a href="/terms">Terms</a>
		</form>
	`;

	it("offers on weak signals when the site has no saved logins", () => {
		path("/signup");
		loadHTML(weakSignupForm);
		expect(shouldSuggestPassword(pw(), { hasExistingLogins: false })).toBe(true);
	});

	it("suppresses weak-signal offers for returning users", () => {
		path("/signup");
		loadHTML(weakSignupForm);
		expect(shouldSuggestPassword(pw(), { hasExistingLogins: true })).toBe(false);
	});

	it("still offers to returning users on a confirm pair", () => {
		// Two rendered password boxes to set is a fact about the DOM that no login form can
		// present, so it outranks the damper the way the token no longer does.
		loadHTML(`
			<form>
				<input type="email" />
				<input type="password" name="p1" />
				<input type="password" name="p2" />
			</form>
		`);
		expect(shouldSuggestPassword(pw(), { hasExistingLogins: true })).toBe(true);
	});

	it("does not take a lone new-password token over the user's own saved login", () => {
		// The token is a claim the page writes, and sites put it on LOGIN fields precisely to
		// stop a browser offering the saved password there. Where the site already holds a
		// login for this user, that claim alone is not enough to hide it.
		loadHTML(`
			<form>
				<input type="email" />
				<input type="password" autocomplete="new-password" />
			</form>
		`);
		expect(shouldSuggestPassword(pw(), { hasExistingLogins: true })).toBe(false);
		// Nothing said to the contrary, though, and it still reaches THRESHOLD on its own.
		expect(shouldSuggestPassword(pw(), { hasExistingLogins: false })).toBe(true);
	});
});

describe("scoreSignupForm", () => {
	it("reports the contributing signals", () => {
		path("/signup");
		loadHTML(`
			<form>
				<input type="password" autocomplete="new-password" />
				<input type="password" name="confirm" />
				<a href="/privacy">Privacy</a>
			</form>
		`);
		const { veto, signals, score } = scoreSignupForm(pw());
		expect(veto).toBe(false);
		expect(signals).toEqual(
			expect.arrayContaining(["new-password-token", "confirm-pair", "signup-url", "terms-link"]),
		);
		expect(score).toBeGreaterThanOrEqual(100);
	});
});

describe("isPasswordChangeForm / isAccountCreationForm (save-new vs update intent)", () => {
	it("classifies a change form as a rotation, not account creation", () => {
		loadHTML(`
			<form>
				<input type="password" name="current" autocomplete="current-password" />
				<input type="password" name="new" autocomplete="new-password" />
				<input type="password" name="confirm" />
			</form>
		`);
		expect(isPasswordChangeForm(pw(1))).toBe(true);
		expect(isAccountCreationForm(pw(1))).toBe(false);
	});

	it("classifies a signup form as account creation", () => {
		loadHTML(`
			<form>
				<input type="email" autocomplete="email" />
				<input type="password" autocomplete="new-password" />
			</form>
		`);
		expect(isPasswordChangeForm(pw())).toBe(false);
		expect(isAccountCreationForm(pw())).toBe(true);
	});

	it("treats a reset form (new + confirm, no identifier) as a rotation, not creation", () => {
		// No identifier to fill in means the account already exists: the reset link
		// identified it. Forcing a fresh save here duplicates the saved login; letting
		// dedupe decide offers "Update" instead, and still offers "Save" if none matches.
		loadHTML(`
			<form>
				<input type="password" name="new" />
				<input type="password" name="confirm" />
			</form>
		`);
		expect(isPasswordChangeForm(pw(0))).toBe(false);
		expect(isAccountCreationForm(pw(0))).toBe(false);
		// It is still a form we should offer a generated password on.
		expect(shouldSuggestPassword(pw(0))).toBe(true);
	});

	it("still treats a signup form as account creation once the email is typed in", () => {
		loadHTML(`
			<form>
				<input type="email" autocomplete="email" value="me@example.com" />
				<input type="password" autocomplete="new-password" />
				<button type="submit">Create account</button>
			</form>
		`);
		expect(isAccountCreationForm(pw())).toBe(true);
	});

	it("treats a reset form with a readonly identifier as a rotation", () => {
		loadHTML(`
			<form>
				<input type="email" autocomplete="username" value="me@example.com" readonly />
				<input type="password" name="new" autocomplete="new-password" />
			</form>
		`);
		expect(isAccountCreationForm(pw())).toBe(false);
	});

	it("does not treat a login form as account creation", () => {
		loadHTML(`
			<form>
				<input type="email" autocomplete="username" />
				<input type="password" autocomplete="current-password" />
			</form>
		`);
		expect(isAccountCreationForm(pw())).toBe(false);
	});
});

describe("isOnAccountCreationForm (the rest of the form)", () => {
	/** The nth non-password input (0-indexed) in the document. */
	function field(n = 0): HTMLInputElement {
		return document.querySelectorAll<HTMLInputElement>('input:not([type="password"])')[n]!;
	}

	it("answers for a signup form's email box, which says nothing itself", () => {
		loadHTML(`
			<form>
				<input type="email" name="email" autocomplete="email" />
				<input type="password" name="password" autocomplete="new-password" />
				<button type="submit">Create account</button>
			</form>
		`);
		expect(isOnAccountCreationForm(field())).toBe(true);
	});

	it("leaves a login form's username box alone", () => {
		loadHTML(`
			<form>
				<input type="email" name="email" autocomplete="username" />
				<input type="password" name="password" autocomplete="current-password" />
				<button type="submit">Sign in</button>
			</form>
		`);
		expect(isOnAccountCreationForm(field())).toBe(false);
	});

	it("leaves a reset form's identifier alone: it sets a password, it does not create an account", () => {
		loadHTML(`
			<form>
				<input type="email" name="email" autocomplete="username" readonly value="me@example.com" />
				<input type="password" name="new" autocomplete="new-password" />
				<input type="password" name="confirm" />
			</form>
		`);
		expect(isOnAccountCreationForm(field())).toBe(false);
	});

	it("reads a confirm-email pair as account creation, with no password box in reach", () => {
		// The signup split across steps: the credential is invented on the NEXT screen, so
		// there is no password field to score. Asking for the email twice is the tell.
		loadHTML(`
			<form>
				<input type="email" name="email" autocomplete="email" />
				<input type="email" name="email_confirm" />
				<button type="submit">Continue</button>
			</form>
		`);
		expect(isOnAccountCreationForm(field())).toBe(true);
	});

	it("reads a labelled confirm-email pair that declares neither type nor token", () => {
		loadHTML(`
			<form>
				<label for="a">Email address</label>
				<input id="a" type="text" name="a" />
				<label for="b">Repeat your Email address</label>
				<input id="b" type="text" name="b" />
				<button type="submit">Continue</button>
			</form>
		`);
		expect(isOnAccountCreationForm(field())).toBe(true);
	});

	it("leaves the email screen of a two-step login alone: it asks once", () => {
		// The shape this must never swallow. A /signin route with a "Create account" link
		// scores like a signup on page-level signals alone, which is why only the pair counts.
		path("/signin");
		loadHTML(`
			<form>
				<input type="email" name="email" autocomplete="username" />
				<button type="submit">Next</button>
			</form>
			<a href="/register">Create account</a>
		`);
		expect(isOnAccountCreationForm(field())).toBe(false);
	});

	it("does not pair an account-number box with an email box", () => {
		loadHTML(`
			<form>
				<label for="a">Account number</label>
				<input id="a" type="text" name="account" />
				<label for="b">Email</label>
				<input id="b" type="email" name="email" />
				<button type="submit">Continue</button>
			</form>
		`);
		expect(isOnAccountCreationForm(field())).toBe(false);
	});

	it("vetoes on a current-password box, whatever the rest of the form asks twice", () => {
		loadHTML(`
			<form>
				<input type="email" name="email" autocomplete="username" />
				<input type="email" name="email_confirm" />
				<input type="password" name="password" autocomplete="current-password" />
				<button type="submit">Sign in</button>
			</form>
		`);
		expect(isOnAccountCreationForm(field())).toBe(false);
	});
});

describe("signupPasswordFields", () => {
	it("returns the new-password fields and excludes the current-password field", () => {
		loadHTML(`
			<form>
				<input type="password" name="current" autocomplete="current-password" />
				<input type="password" name="new" autocomplete="new-password" />
				<input type="password" name="confirm" />
			</form>
		`);
		const names = signupPasswordFields(pw(1)).map((el) => el.name);
		expect(names).toEqual(["new", "confirm"]);
	});
});

/** The nth email-ish field (0-indexed) in the document. */
function emailField(n = 0): HTMLInputElement {
	return document.querySelectorAll<HTMLInputElement>('input:not([type="password"])')[
		n
	] as HTMLInputElement;
}

// The alias suggestion's whole gate. The case that matters is the minimal form, because signup
// and login now look identical: one email box, one password box. See docs/email-aliases.md.
describe("shouldSuggestAlias", () => {
	it("offers on a minimal signup form", () => {
		path("/signup");
		loadHTML(`<form>
			<input type="email" name="email">
			<input type="password" autocomplete="new-password">
			<button>Create account</button>
		</form>`);
		expect(shouldSuggestAlias(emailField())).toBe(true);
	});

	// The strongest separator, and a veto rather than a weight: a form asking for the password
	// you already have is not creating an account.
	it("declines a minimal login form that names its password as current", () => {
		path("/login");
		loadHTML(`<form>
			<input type="email" name="email">
			<input type="password" autocomplete="current-password">
			<button>Sign in</button>
		</form>`);
		expect(shouldSuggestAlias(emailField())).toBe(false);
	});

	// The genuinely hard one: identical markup, no autocomplete tokens at all. It is the page's
	// negative evidence that settles it, not the shape of the form.
	it("declines a minimal login form with no autocomplete tokens at all", () => {
		path("/login");
		loadHTML(`<form>
			<input type="email" name="email">
			<input type="password" name="password">
			<button>Log in</button>
			<a href="/reset">Forgot password?</a>
		</form>`);
		expect(shouldSuggestAlias(emailField())).toBe(false);
	});

	it("offers on the same markup when the page says signup instead", () => {
		path("/register");
		loadHTML(`<form>
			<input type="email" name="email">
			<input type="password" name="password" minlength="8">
			<button>Create account</button>
			<a href="/terms">Terms of Service</a>
		</form>`);
		expect(shouldSuggestAlias(emailField())).toBe(true);
	});

	// A filled box is the account the user already has here; replacing it locks them out.
	it("declines an email field that already has a value", () => {
		path("/signup");
		loadHTML(`<form>
			<input type="email" name="email" value="me@example.com">
			<input type="password" autocomplete="new-password">
			<button>Create account</button>
		</form>`);
		expect(shouldSuggestAlias(emailField())).toBe(false);
	});

	// An alias in a box that wanted a handle is a broken signup.
	it("declines a username field on a signup form", () => {
		path("/signup");
		loadHTML(`<form>
			<input type="text" name="username" autocomplete="username">
			<input type="password" autocomplete="new-password">
			<button>Create account</button>
		</form>`);
		expect(shouldSuggestAlias(emailField())).toBe(false);
	});

	it("declines the password field itself", () => {
		path("/signup");
		loadHTML(`<form>
			<input type="email" name="email">
			<input type="password" autocomplete="new-password">
			<button>Create account</button>
		</form>`);
		expect(shouldSuggestAlias(pw())).toBe(false);
	});

	// No password box in reach: a newsletter box on a marketing page, not an account.
	it("declines a lone email box with no password anywhere", () => {
		path("/signup");
		loadHTML(`<form>
			<input type="email" name="email">
			<button>Subscribe</button>
		</form>`);
		expect(shouldSuggestAlias(emailField())).toBe(false);
	});

	// A signup split across steps invents the password on the next screen, so the confirm-email
	// pair is the only thing decisive enough to act on.
	it("offers on a split signup that asks for the email twice", () => {
		path("/register");
		loadHTML(`<form>
			<input type="email" name="email">
			<input type="email" name="email_confirm">
			<button>Continue</button>
		</form>`);
		expect(shouldSuggestAlias(emailField())).toBe(true);
	});

	// A two-step login's email screen looks the same minus the second box, and getting it wrong
	// would put an alias where the user's actual address belongs.
	it("declines a two-step login's email screen", () => {
		path("/login");
		loadHTML(`<form>
			<input type="email" name="email">
			<button>Next</button>
		</form>`);
		expect(shouldSuggestAlias(emailField())).toBe(false);
	});
});
