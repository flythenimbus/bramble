/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isAccountCreationForm,
	isPasswordChangeForm,
	scoreSignupForm,
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

	it("still offers to returning users when a strong signal is present", () => {
		loadHTML(`
			<form>
				<input type="email" />
				<input type="password" autocomplete="new-password" />
			</form>
		`);
		expect(shouldSuggestPassword(pw(), { hasExistingLogins: true })).toBe(true);
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

	it("treats a reset form (new + confirm, no current) as account creation", () => {
		loadHTML(`
			<form>
				<input type="password" name="new" />
				<input type="password" name="confirm" />
			</form>
		`);
		expect(isPasswordChangeForm(pw(0))).toBe(false);
		expect(isAccountCreationForm(pw(0))).toBe(true);
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
