/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
	candidateKind,
	cardFieldsPresent,
	detectCardFields,
	detectLoginFields,
	findNewPasswordOnChangeForm,
	hasInteractiveCaptcha,
	otpInputs,
} from "../content/detection";
import { loadFixture } from "./load";

beforeEach(() => {
	document.body.innerHTML = "";
});

describe("github.com — sign in", () => {
	it("identifies the login + password fields", () => {
		loadFixture("github-login");
		const { username, password } = detectLoginFields();
		expect(username?.getAttribute("name")).toBe("login");
		expect(password?.getAttribute("name")).toBe("password");
	});

	it("doesn't detect any card fields", () => {
		loadFixture("github-login");
		expect(cardFieldsPresent(detectCardFields())).toBe(false);
	});

	it("doesn't detect any OTP fields", () => {
		loadFixture("github-login");
		expect(otpInputs()).toEqual([]);
	});

	it("doesn't detect a captcha", () => {
		loadFixture("github-login");
		expect(hasInteractiveCaptcha()).toBe(false);
	});

	it("classifies the password field as login", () => {
		loadFixture("github-login");
		const pw = document.querySelector<HTMLInputElement>('input[name="password"]')!;
		expect(candidateKind(pw)).toBe("login");
	});

	it("classifies the login field as login", () => {
		loadFixture("github-login");
		const u = document.querySelector<HTMLInputElement>('input[name="login"]')!;
		expect(candidateKind(u)).toBe("login");
	});

	it("doesn't pick the honeypot text input as username", () => {
		// `required_field_4f63` is a type=text honeypot; detectors don't filter
		// on `hidden`, so this locks in the DOM-order safety net.
		loadFixture("github-login");
		const { username } = detectLoginFields();
		expect(username?.getAttribute("name")).not.toBe("required_field_4f63");
	});
});

describe("bmo.com — sign in (label says 'card number' but it's the login)", () => {
	// BMO uses the debit card number as the login id, so the username field's
	// label matches CC_NUMBER_RE; candidateKind prefers login over card.

	it("detectLoginFields finds the username and password fields", () => {
		loadFixture("bmo-login");
		const { username, password } = detectLoginFields();
		expect(username?.getAttribute("name")).toBe("username-input");
		expect(password?.getAttribute("name")).toBe("password-input");
	});

	it("candidateKind classifies the username as 'login' (not 'card')", () => {
		loadFixture("bmo-login");
		const username = document.querySelector<HTMLInputElement>('input[name="username-input"]')!;
		expect(candidateKind(username)).toBe("login");
	});

	it("password field is classified as login", () => {
		loadFixture("bmo-login");
		const password = document.querySelector<HTMLInputElement>('input[name="password-input"]')!;
		expect(candidateKind(password)).toBe("login");
	});

	it("known shallow weakness: detectCardFields still claims the username as card.number", () => {
		// Direct callers of detectCardFields see this false positive; all
		// autofill paths go through candidateKind, which resolves it.
		loadFixture("bmo-login");
		expect(detectCardFields().number?.getAttribute("name")).toBe("username-input");
	});

	it("doesn't detect any OTP fields", () => {
		loadFixture("bmo-login");
		expect(otpInputs()).toEqual([]);
	});

	it("doesn't detect a captcha", () => {
		loadFixture("bmo-login");
		expect(hasInteractiveCaptcha()).toBe(false);
	});
});

describe("github.com — change password (old / new / confirm)", () => {
	// GitHub sets autocomplete="off" on the new-password field, so detection
	// falls through to the name/id/label regex rung ("new" wins).

	function loadAndSetValues(values: Record<string, string>): void {
		loadFixture("github-password-change");
		for (const [name, value] of Object.entries(values)) {
			const el = document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
			if (!el) throw new Error(`no input[name="${name}"]`);
			el.value = value;
		}
	}

	it("returns null when no values have been entered yet", () => {
		loadFixture("github-password-change");
		expect(findNewPasswordOnChangeForm()).toBeNull();
	});

	it("picks the new-password field when new and confirm match", () => {
		loadAndSetValues({
			"user[old_password]": "old",
			"user[password]": "shiny-new-15-chars",
			"user[password_confirmation]": "shiny-new-15-chars",
		});
		const field = findNewPasswordOnChangeForm();
		expect(field?.getAttribute("name")).toBe("user[password]");
	});

	it("returns null when confirm doesn't match new", () => {
		loadAndSetValues({
			"user[old_password]": "old",
			"user[password]": "shiny-new-15-chars",
			"user[password_confirmation]": "shiny-new-15-chrs",
		});
		expect(findNewPasswordOnChangeForm()).toBeNull();
	});

	it("returns null when confirm is empty (mid-edit)", () => {
		loadAndSetValues({
			"user[old_password]": "old",
			"user[password]": "shiny-new-15-chars",
		});
		expect(findNewPasswordOnChangeForm()).toBeNull();
	});

	it("returns null when only the old password is entered", () => {
		loadAndSetValues({ "user[old_password]": "old" });
		expect(findNewPasswordOnChangeForm()).toBeNull();
	});

	it("detectLoginFields finds the first (old) password — no text username here", () => {
		// With no username field, findPasswordField returns the first password;
		// callers must branch on findNewPasswordOnChangeForm when >=2 are present.
		loadFixture("github-password-change");
		const { username, password } = detectLoginFields();
		expect(username).toBeNull();
		expect(password?.getAttribute("name")).toBe("user[old_password]");
	});

	it("doesn't pick the honeypot text input as a username candidate", () => {
		// `required_field_e345` honeypot sits after all password fields; safe via
		// DOM order and a name that doesn't match USERNAME_HINT_RE.
		loadFixture("github-password-change");
		expect(detectLoginFields().username).toBeNull();
	});

	it("classifies all three password fields as login", () => {
		loadFixture("github-password-change");
		for (const name of ["user[old_password]", "user[password]", "user[password_confirmation]"]) {
			const el = document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
			expect(candidateKind(el)).toBe("login");
		}
	});

	it("doesn't detect any card / OTP / captcha", () => {
		loadFixture("github-password-change");
		expect(cardFieldsPresent(detectCardFields())).toBe(false);
		expect(otpInputs()).toEqual([]);
		expect(hasInteractiveCaptcha()).toBe(false);
	});
});

describe("discord.com — sign in", () => {
	// Discord uses a multi-token `autocomplete="username webauthn"`; captcha is
	// shown only on suspicious activity, so this snapshot has none.

	it("detectLoginFields finds the email + password fields", () => {
		loadFixture("discord-login");
		const { username, password } = detectLoginFields();
		expect(username?.getAttribute("name")).toBe("email");
		expect(password?.getAttribute("name")).toBe("password");
	});

	it("handles the multi-token autocomplete='username webauthn'", () => {
		// Asserts rung 2 uses `~=` (token match), not `=`.
		loadFixture("discord-login");
		const email = document.querySelector<HTMLInputElement>('input[name="email"]')!;
		expect(email.autocomplete).toBe("username webauthn");
		expect(candidateKind(email)).toBe("login");
	});

	it("password field classifies as login", () => {
		loadFixture("discord-login");
		const password = document.querySelector<HTMLInputElement>('input[name="password"]')!;
		expect(candidateKind(password)).toBe("login");
	});

	it("doesn't detect a captcha on the default form", () => {
		// Discord injects captcha only after a server-side challenge.
		loadFixture("discord-login");
		expect(hasInteractiveCaptcha()).toBe(false);
	});

	it("doesn't detect any card / OTP fields", () => {
		loadFixture("discord-login");
		expect(cardFieldsPresent(detectCardFields())).toBe(false);
		expect(otpInputs()).toEqual([]);
	});

	it("the country-code button (BR +55) doesn't sneak in as an input", () => {
		// The country-code selector is a `<div role="button">`, not an input.
		loadFixture("discord-login");
		const inputs = document.querySelectorAll("input");
		expect(inputs.length).toBe(2);
	});
});

describe("twitch.tv — sign in", () => {
	// Twitch inputs have no `name`, only `id`; social-login buttons are
	// `<button>`s, not inputs.

	it("detectLoginFields finds the username + password by id", () => {
		loadFixture("twitch-login");
		const { username, password } = detectLoginFields();
		expect(username?.id).toBe("login-username");
		expect(password?.id).toBe("password-input");
	});

	it("classifies both fields as login", () => {
		loadFixture("twitch-login");
		const username = document.getElementById("login-username") as HTMLInputElement;
		const password = document.getElementById("password-input") as HTMLInputElement;
		expect(candidateKind(username)).toBe("login");
		expect(candidateKind(password)).toBe("login");
	});

	it("social-login buttons don't surface as inputs", () => {
		loadFixture("twitch-login");
		expect(document.querySelectorAll("input").length).toBe(2);
	});

	it("doesn't detect any card / OTP / captcha", () => {
		loadFixture("twitch-login");
		expect(cardFieldsPresent(detectCardFields())).toBe(false);
		expect(otpInputs()).toEqual([]);
		expect(hasInteractiveCaptcha()).toBe(false);
	});
});

describe("amazon.com — add a payment method", () => {
	// No <form> wrapper, no CVV in the add-card flow, combined MM/YY expiry,
	// all three inputs tagged with `autocomplete="cc-*"`.

	it("detectCardFields finds number, name, and combined expiry", () => {
		loadFixture("amazon-add-payment");
		const c = detectCardFields();
		expect(c.number?.getAttribute("autocomplete")).toBe("cc-number");
		expect(c.name?.getAttribute("autocomplete")).toBe("cc-name");
		expect(c.expCombined?.getAttribute("autocomplete")).toBe("cc-exp");
	});

	it("expMonth / expYear are null (combined, not split)", () => {
		loadFixture("amazon-add-payment");
		const c = detectCardFields();
		expect(c.expMonth).toBeNull();
		expect(c.expYear).toBeNull();
	});

	it("CVV is null (Amazon collects it separately)", () => {
		// "Name on card" / "Card number" must not match CC_CSC_RE's `card.?code`.
		loadFixture("amazon-add-payment");
		expect(detectCardFields().cvv).toBeNull();
	});

	it("cardFieldsPresent returns true", () => {
		loadFixture("amazon-add-payment");
		expect(cardFieldsPresent(detectCardFields())).toBe(true);
	});

	it("all three inputs classify as 'card' via candidateKind", () => {
		loadFixture("amazon-add-payment");
		for (const ac of ["cc-number", "cc-exp", "cc-name"]) {
			const el = document.querySelector<HTMLInputElement>(`input[autocomplete="${ac}"]`)!;
			expect(candidateKind(el)).toBe("card");
		}
	});

	it("detectLoginFields returns {null, null} — no password field to anchor", () => {
		loadFixture("amazon-add-payment");
		const { username, password } = detectLoginFields();
		expect(username).toBeNull();
		expect(password).toBeNull();
	});

	it("the cardholder-name field doesn't false-positive as username", () => {
		// "Name on card" / cc-name must not match USERNAME_HINT_RE.
		loadFixture("amazon-add-payment");
		const name = document.querySelector<HTMLInputElement>('input[autocomplete="cc-name"]')!;
		expect(candidateKind(name)).toBe("card"); // not "login"
	});

	it("works without a <form> wrapper", () => {
		// Amazon's modal is all <div>s; detectors walk the document by default.
		loadFixture("amazon-add-payment");
		expect(document.querySelector("form")).toBeNull();
		expect(cardFieldsPresent(detectCardFields())).toBe(true);
	});

	it("doesn't detect OTP / captcha", () => {
		loadFixture("amazon-add-payment");
		expect(otpInputs()).toEqual([]);
		expect(hasInteractiveCaptcha()).toBe(false);
	});

	it("has exactly 3 inputs (no honeypots)", () => {
		loadFixture("amazon-add-payment");
		expect(document.querySelectorAll("input").length).toBe(3);
	});

	it("handles untyped inputs (no `type` attribute on number / exp)", () => {
		// Number/expiry omit `type`; browsers default to "text".
		loadFixture("amazon-add-payment");
		const number = document.querySelector<HTMLInputElement>('input[autocomplete="cc-number"]')!;
		expect(number.hasAttribute("type")).toBe(false);
		expect(number.type).toBe("text");
		expect(candidateKind(number)).toBe("card");
	});
});

describe("login.microsoftonline.com — email step (two-step SSO)", () => {
	// Microsoft renders an off-screen `type="password"` on the email step;
	// detectors don't filter on its hidden hints, so we treat it as the page
	// password (matching browser pwd-manager behaviour).

	it("detectLoginFields finds the email input as username", () => {
		loadFixture("microsoft-login-email");
		const { username } = detectLoginFields();
		expect(username?.getAttribute("name")).toBe("loginfmt");
		expect(username?.getAttribute("type")).toBe("email");
	});

	it("finds the off-screen password as the page's password field", () => {
		loadFixture("microsoft-login-email");
		const { password } = detectLoginFields();
		expect(password?.getAttribute("name")).toBe("passwd");
		expect(password?.getAttribute("aria-hidden")).toBe("true");
		expect(password?.className).toContain("moveOffScreen");
	});

	it("multi-token autocomplete='username webauthn' matches via ~=", () => {
		loadFixture("microsoft-login-email");
		const email = document.querySelector<HTMLInputElement>('input[name="loginfmt"]')!;
		expect(email.autocomplete).toBe("username webauthn");
	});

	it("classifies both fields as login", () => {
		loadFixture("microsoft-login-email");
		const email = document.querySelector<HTMLInputElement>('input[name="loginfmt"]')!;
		const pw = document.querySelector<HTMLInputElement>('input[name="passwd"]')!;
		expect(candidateKind(email)).toBe("login");
		expect(candidateKind(pw)).toBe("login");
	});

	it("no card / OTP / captcha false positives", () => {
		loadFixture("microsoft-login-email");
		expect(cardFieldsPresent(detectCardFields())).toBe(false);
		expect(otpInputs()).toEqual([]);
		expect(hasInteractiveCaptcha()).toBe(false);
	});
});

describe("login.microsoftonline.com — password step (two-step SSO)", () => {
	// Email carries through as a hidden `autocomplete="displayUsername"` input;
	// the `~=` token match is whole-word so it doesn't false-positive on it.

	it("detectLoginFields finds password but no username (email is on a prior page)", () => {
		loadFixture("microsoft-login-password");
		const { username, password } = detectLoginFields();
		expect(password?.id).toBe("passwordEntry");
		expect(username).toBeNull();
	});

	it("hidden 'displayUsername' carry-through doesn't false-positive", () => {
		// `~="username"` is whole-word; `displayUsername` is one token, not a match.
		loadFixture("microsoft-login-password");
		const carry = document.querySelector<HTMLInputElement>(
			'input[autocomplete="displayUsername"]',
		)!;
		expect(carry.type).toBe("hidden");
		expect(detectLoginFields().username).toBeNull();
	});

	it("password classifies as login", () => {
		loadFixture("microsoft-login-password");
		const pw = document.querySelector<HTMLInputElement>("#passwordEntry") as HTMLInputElement;
		expect(candidateKind(pw)).toBe("login");
	});

	it("form-level autocomplete='off' doesn't disable detection", () => {
		// Detectors ignore a form's autocomplete="off"; we autofill regardless.
		loadFixture("microsoft-login-password");
		expect(document.querySelector("form")?.getAttribute("autocomplete")).toBe("off");
		expect(detectLoginFields().password).not.toBeNull();
	});

	it("no card / OTP / captcha false positives", () => {
		loadFixture("microsoft-login-password");
		expect(cardFieldsPresent(detectCardFields())).toBe(false);
		expect(otpInputs()).toEqual([]);
		expect(hasInteractiveCaptcha()).toBe(false);
	});
});

describe("github.com — 2FA (TOTP)", () => {
	// GitHub 2FA has no `one-time-code` token; it uses name="otp", caught by the
	// hint rung via `\botp\b`.

	it("otpInputs finds the 6-digit OTP field via hint-based detection", () => {
		loadFixture("github-2fa");
		const fields = otpInputs();
		expect(fields).toHaveLength(1);
		expect(fields[0]?.getAttribute("name")).toBe("otp");
	});

	it("the field has no `autocomplete='one-time-code'` token (fallback rung exercised)", () => {
		// GitHub doesn't use the standard token; the hint rung must cover it.
		loadFixture("github-2fa");
		const otp = document.querySelector<HTMLInputElement>('input[name="otp"]')!;
		expect(otp.autocomplete).toBe("off");
	});

	it("candidateKind classifies the OTP field as 'otp'", () => {
		loadFixture("github-2fa");
		const otp = document.querySelector<HTMLInputElement>('input[name="otp"]')!;
		expect(candidateKind(otp)).toBe("otp");
	});

	it("detectLoginFields returns null/null (no username or password here)", () => {
		loadFixture("github-2fa");
		const { username, password } = detectLoginFields();
		expect(username).toBeNull();
		expect(password).toBeNull();
	});

	it("no card / captcha false positives", () => {
		loadFixture("github-2fa");
		expect(cardFieldsPresent(detectCardFields())).toBe(false);
		expect(hasInteractiveCaptcha()).toBe(false);
	});
});

describe("reddit.com — sign in (faceplate-text-input web components)", () => {
	// Reddit wraps its login + password inputs in <faceplate-text-input> custom
	// elements. The real <input> is rendered by Reddit's JS into the component's
	// shadow root at runtime (the slotted <span slot="label"> children prove a
	// shadow root exists). A static capture therefore has NO login <input> at
	// all, and our detectors only walk light-DOM inputs.

	it("the login fields are web components, not light-DOM inputs", () => {
		loadFixture("reddit-login");
		expect(document.querySelector('faceplate-text-input[name="username"]')).not.toBeNull();
		expect(document.querySelector('faceplate-text-input[name="password"]')).not.toBeNull();
		// No real password input in the light DOM.
		expect(document.querySelector('input[type="password"]')).toBeNull();
	});

	it("the only light-DOM input is the search box", () => {
		loadFixture("reddit-login");
		const inputs = document.querySelectorAll("input");
		expect(inputs.length).toBe(1);
		expect(inputs[0]?.getAttribute("name")).toBe("q");
	});

	it("KNOWN LIMITATION: detectLoginFields finds nothing (inputs live in shadow DOM)", () => {
		// Our detectors walk light-DOM inputs only; they never pierce a component's
		// shadow root. So Reddit's login form yields no candidates and autofill
		// never offers. This locks in the current behavior; flip it when/if
		// shadow-DOM traversal lands.
		loadFixture("reddit-login");
		const { username, password } = detectLoginFields();
		expect(username).toBeNull();
		expect(password).toBeNull();
		expect(otpInputs()).toEqual([]);
		expect(cardFieldsPresent(detectCardFields())).toBe(false);
	});
});

describe("biteasy.co — sign in with invisible/managed Cloudflare Turnstile", () => {
	// Invisible Turnstile must not block autofill: token is in a hidden input,
	// the container is 0x0, and `cf-turnstile` is an id (not the class we match).

	it("detectLoginFields finds the email + password", () => {
		loadFixture("biteasy-login");
		const { username, password } = detectLoginFields();
		expect(username?.getAttribute("name")).toBe("email");
		expect(password?.getAttribute("name")).toBe("password");
	});

	it("classifies both fields as login", () => {
		loadFixture("biteasy-login");
		const email = document.querySelector<HTMLInputElement>('input[name="email"]')!;
		const password = document.querySelector<HTMLInputElement>('input[name="password"]')!;
		expect(candidateKind(email)).toBe("login");
		expect(candidateKind(password)).toBe("login");
	});

	it("invisible Turnstile is NOT detected as an interactive captcha", () => {
		// Doesn't fire: `cf-turnstile` is an id (not the `.cf-turnstile` class),
		// and the 0x0 container fails isRendered anyway.
		loadFixture("biteasy-login");
		expect(hasInteractiveCaptcha()).toBe(false);
		expect(document.getElementById("cf-turnstile")).not.toBeNull();
	});

	it("hidden cf-turnstile-response input is invisible to our detectors", () => {
		// `type="hidden"` excludes it from every detector's candidate pool.
		loadFixture("biteasy-login");
		const tsResponse = document.querySelector<HTMLInputElement>(
			'input[name="cf-turnstile-response"]',
		)!;
		expect(tsResponse.type).toBe("hidden");
		expect(otpInputs()).toEqual([]);
		expect(cardFieldsPresent(detectCardFields())).toBe(false);
	});

	it("the Stripe metrics iframe doesn't trigger captcha detection", () => {
		// Stripe's analytics iframe must not match any captcha selector (its src
		// is scrubbed in the fixture, so it's identified by Stripe-specific name).
		loadFixture("biteasy-login");
		const stripeIframe = document.querySelector('iframe[name^="__privateStripe"]');
		expect(stripeIframe).not.toBeNull();
		expect(hasInteractiveCaptcha()).toBe(false);
	});
});
