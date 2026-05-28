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
} from "../detection";
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
		loadFixture("github-login");
		const { username } = detectLoginFields();
		expect(username?.getAttribute("name")).not.toBe("required_field_4f63");
	});
});

describe("bmo.com — sign in (label says 'card number' but it's the login)", () => {

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
		loadFixture("github-password-change");
		const { username, password } = detectLoginFields();
		expect(username).toBeNull();
		expect(password?.getAttribute("name")).toBe("user[old_password]");
	});

	it("doesn't pick the honeypot text input as a username candidate", () => {
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

	it("detectLoginFields finds the email + password fields", () => {
		loadFixture("discord-login");
		const { username, password } = detectLoginFields();
		expect(username?.getAttribute("name")).toBe("email");
		expect(password?.getAttribute("name")).toBe("password");
	});

	it("handles the multi-token autocomplete='username webauthn'", () => {
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
		loadFixture("discord-login");
		expect(hasInteractiveCaptcha()).toBe(false);
	});

	it("doesn't detect any card / OTP fields", () => {
		loadFixture("discord-login");
		expect(cardFieldsPresent(detectCardFields())).toBe(false);
		expect(otpInputs()).toEqual([]);
	});

	it("the country-code button (BR +55) doesn't sneak in as an input", () => {
		loadFixture("discord-login");
		const inputs = document.querySelectorAll("input");
		expect(inputs.length).toBe(2);
	});
});

describe("twitch.tv — sign in", () => {

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
		loadFixture("amazon-add-payment");
		const name = document.querySelector<HTMLInputElement>('input[autocomplete="cc-name"]')!;
		expect(candidateKind(name)).toBe("card"); // not "login"
	});

	it("works without a <form> wrapper", () => {
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
		loadFixture("amazon-add-payment");
		const number = document.querySelector<HTMLInputElement>('input[autocomplete="cc-number"]')!;
		expect(number.hasAttribute("type")).toBe(false);
		expect(number.type).toBe("text");
		expect(candidateKind(number)).toBe("card");
	});
});

describe("login.microsoftonline.com — email step (two-step SSO)", () => {

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

	it("detectLoginFields finds password but no username (email is on a prior page)", () => {
		loadFixture("microsoft-login-password");
		const { username, password } = detectLoginFields();
		expect(password?.id).toBe("passwordEntry");
		expect(username).toBeNull();
	});

	it("hidden 'displayUsername' carry-through doesn't false-positive", () => {
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

	it("otpInputs finds the 6-digit OTP field via hint-based detection", () => {
		loadFixture("github-2fa");
		const fields = otpInputs();
		expect(fields).toHaveLength(1);
		expect(fields[0]?.getAttribute("name")).toBe("otp");
	});

	it("the field has no `autocomplete='one-time-code'` token (fallback rung exercised)", () => {
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
		// pages.
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

describe("biteasy.co — sign in with invisible/managed Cloudflare Turnstile", () => {

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
		loadFixture("biteasy-login");
		const stripeIframe = document.querySelector('iframe[name^="__privateStripe"]');
		expect(stripeIframe).not.toBeNull();
		expect(hasInteractiveCaptcha()).toBe(false);
	});
});
