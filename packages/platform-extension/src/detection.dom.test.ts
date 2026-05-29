/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
	candidateKind,
	cardFieldsPresent,
	deriveMatcher,
	detectCardFields,
	detectLoginFields,
	findNewPasswordOnChangeForm,
	findPasswordField,
	getFillableInputs,
	hasInteractiveCaptcha,
	isAutofillCandidate,
	isCardField,
	matchesField,
	otpInputs,
} from "./detection";

function loadHTML(html: string): void {
	document.body.innerHTML = html;
}

beforeEach(() => {
	document.body.innerHTML = "";
});

describe("detectLoginFields — happy path", () => {
	it("finds a basic email+password form", () => {
		loadHTML(`
			<form>
				<input type="email" name="email" />
				<input type="password" name="password" />
				<button type="submit">Sign in</button>
			</form>
		`);
		const { username, password } = detectLoginFields();
		expect(username?.getAttribute("name")).toBe("email");
		expect(password?.getAttribute("name")).toBe("password");
	});

	it("scopes the username search to the enclosing form", () => {
		loadHTML(`
			<input type="text" name="search" placeholder="Search" />
			<form>
				<input type="text" name="username" />
				<input type="password" name="password" />
			</form>
		`);
		const { username } = detectLoginFields();
		expect(username?.getAttribute("name")).toBe("username");
	});

	it("prefers explicit autocomplete=username over text-input heuristics", () => {
		loadHTML(`
			<input type="text" name="random" />
			<input type="text" autocomplete="username" name="user" />
		`);
		const { username, password } = detectLoginFields();
		expect(username?.getAttribute("name")).toBe("user");
		expect(password).toBeNull();
	});
});

describe("detectLoginFields — skips noise", () => {
	it("ignores text inputs whose attributes scream search / coupon / otp", () => {
		loadHTML(`
			<form>
				<input type="text" name="coupon-code" />
				<input type="password" name="password" />
			</form>
		`);
		expect(detectLoginFields().username).toBeNull();
	});

	it("ignores readonly and disabled inputs", () => {
		loadHTML(`
			<form>
				<input type="text" name="username" readonly />
				<input type="password" name="password" disabled />
			</form>
		`);
		const { username, password } = detectLoginFields();
		expect(username).toBeNull();
		expect(password).toBeNull();
	});
});

describe("findPasswordField", () => {
	it("returns the first usable password field", () => {
		loadHTML(`
			<input type="password" name="a" />
			<input type="password" name="b" />
		`);
		expect(findPasswordField()?.getAttribute("name")).toBe("a");
	});

	it("skips disabled/readonly password fields", () => {
		loadHTML(`
			<input type="password" name="a" disabled />
			<input type="password" name="b" />
		`);
		expect(findPasswordField()?.getAttribute("name")).toBe("b");
	});
});

describe("findNewPasswordOnChangeForm", () => {
	function setValue(name: string, value: string): void {
		const el = document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
		if (!el) throw new Error(`no input[name="${name}"]`);
		el.value = value;
	}

	it("returns null when there's only one password field", () => {
		loadHTML(`<input type="password" name="password" />`);
		expect(findNewPasswordOnChangeForm()).toBeNull();
	});

	it("picks the new-password field when it has a matching confirm", () => {
		loadHTML(`
			<form>
				<input type="password" name="current-password" autocomplete="current-password" />
				<input type="password" name="new-password" autocomplete="new-password" />
				<input type="password" name="confirm-password" autocomplete="new-password" />
			</form>
		`);
		setValue("current-password", "old");
		setValue("new-password", "shiny");
		setValue("confirm-password", "shiny");
		expect(findNewPasswordOnChangeForm()?.getAttribute("name")).toBe("new-password");
	});

	it("returns null when the confirm field hasn't been filled yet", () => {
		loadHTML(`
			<form>
				<input type="password" name="current-password" autocomplete="current-password" />
				<input type="password" name="new-password" autocomplete="new-password" />
				<input type="password" name="confirm-password" autocomplete="new-password" />
			</form>
		`);
		setValue("current-password", "old");
		setValue("new-password", "shiny");
		expect(findNewPasswordOnChangeForm()).toBeNull();
	});

	it("returns null when the confirm field has a different value", () => {
		loadHTML(`
			<form>
				<input type="password" name="new-password" autocomplete="new-password" />
				<input type="password" name="confirm-password" autocomplete="new-password" />
			</form>
		`);
		setValue("new-password", "shiny");
		setValue("confirm-password", "shinx"); // typo
		expect(findNewPasswordOnChangeForm()).toBeNull();
	});

	it("falls back to name/id regex when autocomplete is absent", () => {
		loadHTML(`
			<form>
				<input type="password" name="oldPassword" />
				<input type="password" name="newPassword" />
				<input type="password" name="confirmNewPassword" />
			</form>
		`);
		setValue("oldPassword", "old");
		setValue("newPassword", "shiny");
		setValue("confirmNewPassword", "shiny");
		expect(findNewPasswordOnChangeForm()?.getAttribute("name")).toBe("newPassword");
	});
});

describe("detectCardFields — autocomplete tokens", () => {
	it("picks up the full set when tokens are present", () => {
		loadHTML(`
			<form>
				<input autocomplete="cc-number" name="num" />
				<input autocomplete="cc-name" name="cname" />
				<input autocomplete="cc-exp-month" name="em" />
				<input autocomplete="cc-exp-year" name="ey" />
				<input autocomplete="cc-csc" name="cvc" />
			</form>
		`);
		const c = detectCardFields();
		expect(c.number?.getAttribute("name")).toBe("num");
		expect(c.name?.getAttribute("name")).toBe("cname");
		expect(c.expMonth?.getAttribute("name")).toBe("em");
		expect(c.expYear?.getAttribute("name")).toBe("ey");
		expect(c.cvv?.getAttribute("name")).toBe("cvc");
		expect(c.expCombined).toBeNull();
	});

	it("uses the combined cc-exp token only when no split pair is present", () => {
		loadHTML(`
			<form>
				<input autocomplete="cc-number" name="num" />
				<input autocomplete="cc-exp" name="exp" />
				<input autocomplete="cc-csc" name="cvc" />
			</form>
		`);
		const c = detectCardFields();
		expect(c.expCombined?.getAttribute("name")).toBe("exp");
		expect(c.expMonth).toBeNull();
		expect(c.expYear).toBeNull();
	});
});

describe("detectCardFields — regex fallback", () => {
	it("matches name/id hints when autocomplete is absent", () => {
		loadHTML(`
			<form>
				<input name="card_number" />
				<input name="cardholder" />
				<input name="exp_month" />
				<input name="exp_year" />
				<input type="password" name="cvv-code" />
			</form>
		`);
		const c = detectCardFields();
		expect(c.number?.getAttribute("name")).toBe("card_number");
		expect(c.name?.getAttribute("name")).toBe("cardholder");
		expect(c.expMonth?.getAttribute("name")).toBe("exp_month");
		expect(c.expYear?.getAttribute("name")).toBe("exp_year");
		expect(c.cvv?.getAttribute("name")).toBe("cvv-code");
	});

	it("does not match a CVV when the name is underscore-fused (\\bcvv\\b limitation)", () => {
		loadHTML(`<input type="password" name="cvv_field" />`);
		expect(detectCardFields().cvv).toBeNull();
	});

	it("doesn't pick a CVV out of a non-CVV password field", () => {
		loadHTML(`<form><input type="password" name="password" /></form>`);
		expect(detectCardFields().cvv).toBeNull();
	});
});

describe("cardFieldsPresent / isCardField", () => {
	it("returns false when only a cardholder-name field exists", () => {
		loadHTML(`<input name="cardholder" />`);
		expect(cardFieldsPresent(detectCardFields())).toBe(false);
	});

	it("returns true when any real card field is present", () => {
		loadHTML(`<input autocomplete="cc-number" />`);
		expect(cardFieldsPresent(detectCardFields())).toBe(true);
	});

	it("isCardField identifies each slot", () => {
		loadHTML(`
			<form>
				<input autocomplete="cc-number" name="num" />
				<input autocomplete="cc-csc" name="cvc" />
				<input name="unrelated" />
			</form>
		`);
		const c = detectCardFields();
		const num = document.querySelector<HTMLInputElement>('[name="num"]')!;
		const cvc = document.querySelector<HTMLInputElement>('[name="cvc"]')!;
		const other = document.querySelector<HTMLInputElement>('[name="unrelated"]')!;
		expect(isCardField(c, num)).toBe(true);
		expect(isCardField(c, cvc)).toBe(true);
		expect(isCardField(c, other)).toBe(false);
	});
});

describe("otpInputs", () => {
	it("returns the single autocomplete-tagged field", () => {
		loadHTML(`<input autocomplete="one-time-code" name="otp" />`);
		const fields = otpInputs();
		expect(fields).toHaveLength(1);
		expect(fields[0]?.getAttribute("name")).toBe("otp");
	});

	it("returns every tagged input on a segmented widget", () => {
		loadHTML(`
			<form>
				<input autocomplete="one-time-code" maxlength="1" />
				<input autocomplete="one-time-code" maxlength="1" />
				<input autocomplete="one-time-code" maxlength="1" />
				<input autocomplete="one-time-code" maxlength="1" />
				<input autocomplete="one-time-code" maxlength="1" />
				<input autocomplete="one-time-code" maxlength="1" />
			</form>
		`);
		expect(otpInputs()).toHaveLength(6);
	});

	it("picks up hint-based OTP fields when no token is present", () => {
		loadHTML(`
			<form>
				<input type="email" name="email" />
				<input name="passcode" />
			</form>
		`);
		const fields = otpInputs();
		expect(fields).toHaveLength(1);
		expect(fields[0]?.getAttribute("name")).toBe("passcode");
	});

	it("card detection beats OTP for ambiguous 'verification-code' naming", () => {
		loadHTML(`<input name="verification-code" />`);
		expect(otpInputs()).toEqual([]);
		expect(detectCardFields().cvv?.getAttribute("name")).toBe("verification-code");
	});

	it("gathers a segmented widget when the seed has maxLength=1", () => {
		loadHTML(`
			<form>
				<div>
					<input name="otp1" placeholder="Passcode" maxlength="1" />
					<input name="otp2" maxlength="1" />
					<input name="otp3" maxlength="1" />
					<input name="otp4" maxlength="1" />
				</div>
			</form>
		`);
		const fields = otpInputs();
		expect(fields).toHaveLength(4);
		expect(fields.map((f) => f.getAttribute("name"))).toEqual(["otp1", "otp2", "otp3", "otp4"]);
	});

	it("excludes card fields from OTP detection (CVV / number)", () => {
		loadHTML(`
			<form>
				<input autocomplete="cc-number" name="num" />
				<input autocomplete="cc-csc" name="verification" />
			</form>
		`);
		expect(otpInputs()).toEqual([]);
	});

	it("ignores address / postal / phone fields", () => {
		loadHTML(`
			<form>
				<input name="postal-code" />
				<input name="zip-code" />
				<input name="phone-code" />
			</form>
		`);
		expect(otpInputs()).toEqual([]);
	});
});

describe("hasInteractiveCaptcha", () => {
	function makeVisible(selector: string): void {
		for (const el of document.querySelectorAll(selector)) {
			el.getBoundingClientRect = () =>
				({
					width: 200,
					height: 100,
					top: 0,
					left: 0,
					right: 200,
					bottom: 100,
					x: 0,
					y: 0,
				}) as DOMRect;
		}
	}

	it("returns false when no captcha widget is present", () => {
		loadHTML(`<form><input type="text" /></form>`);
		expect(hasInteractiveCaptcha()).toBe(false);
	});

	it("detects a visible recaptcha widget", () => {
		loadHTML(`<div class="g-recaptcha"></div>`);
		makeVisible(".g-recaptcha");
		expect(hasInteractiveCaptcha()).toBe(true);
	});

	it("detects an hCaptcha widget", () => {
		loadHTML(`<div class="h-captcha"></div>`);
		makeVisible(".h-captcha");
		expect(hasInteractiveCaptcha()).toBe(true);
	});

	it("detects a Cloudflare Turnstile widget", () => {
		loadHTML(`<div class="cf-turnstile"></div>`);
		makeVisible(".cf-turnstile");
		expect(hasInteractiveCaptcha()).toBe(true);
	});

	it("ignores an invisible-sized reCAPTCHA badge (v3)", () => {
		loadHTML(`<div class="g-recaptcha" data-size="invisible"></div>`);
		makeVisible(".g-recaptcha");
		expect(hasInteractiveCaptcha()).toBe(false);
	});

	it("ignores a captcha element that's not actually rendered (0×0)", () => {
		loadHTML(`<div class="h-captcha"></div>`);
		expect(hasInteractiveCaptcha()).toBe(false);
	});
});

describe("deriveMatcher", () => {
	it("splits multi-word keys into hyphenated and canonical forms", () => {
		const m = deriveMatcher("Postal Code");
		expect(m).toEqual({ canonical: "postalcode", hyphen: "postal-code" });
	});

	it("handles single-word keys", () => {
		expect(deriveMatcher("Country")).toEqual({ canonical: "country", hyphen: "country" });
	});

	it("normalises around punctuation", () => {
		const m = deriveMatcher("Tax-ID #");
		expect(m).toEqual({ canonical: "taxid", hyphen: "tax-id" });
	});

	it("returns null for keys with no usable characters", () => {
		expect(deriveMatcher("!!!")).toBeNull();
		expect(deriveMatcher("")).toBeNull();
	});
});

describe("matchesField", () => {
	function input(html: string): HTMLInputElement {
		loadHTML(html);
		return document.querySelector<HTMLInputElement>("input")!;
	}

	it("matches the exact hyphenated autocomplete token", () => {
		const el = input(`<input autocomplete="postal-code" />`);
		expect(matchesField(el, deriveMatcher("Postal Code")!)).toBe(true);
	});

	it("matches the canonical autocomplete token form too", () => {
		const el = input(`<input autocomplete="postalcode" />`);
		expect(matchesField(el, deriveMatcher("Postal Code")!)).toBe(true);
	});

	it("matches when the canonical form appears in name/id/placeholder", () => {
		const el = input(`<input name="postalcode" />`);
		expect(matchesField(el, deriveMatcher("Postal Code")!)).toBe(true);
	});

	it("matches as a substring when the canonical key is ≥5 chars", () => {
		const el = input(`<input name="user-postalcode-field" />`);
		expect(matchesField(el, deriveMatcher("Postal Code")!)).toBe(true);
	});

	it("does NOT substring-match short keys (avoids 'name' → 'username')", () => {
		const el = input(`<input name="username" />`);
		expect(matchesField(el, deriveMatcher("Name")!)).toBe(false);
	});

	it("falls back to the associated <label> text", () => {
		loadHTML(`
			<label for="postal">Postal Code</label>
			<input id="postal" name="opaque" />
		`);
		const el = document.querySelector<HTMLInputElement>("#postal")!;
		expect(matchesField(el, deriveMatcher("Postal Code")!)).toBe(true);
	});

	it("returns false on a wholly unrelated field", () => {
		const el = input(`<input name="something-else" />`);
		expect(matchesField(el, deriveMatcher("Postal Code")!)).toBe(false);
	});
});

describe("getFillableInputs", () => {
	it("returns text-like inputs only", () => {
		loadHTML(`
			<input type="text" name="a" />
			<input type="tel" name="b" />
			<input type="search" name="c" />
			<input type="url" name="d" />
			<input type="number" name="e" />
			<input name="f" />
		`);
		const names = getFillableInputs().map((el) => el.getAttribute("name"));
		expect(names).toEqual(["a", "b", "c", "d", "e", "f"]);
	});

	it("skips password / email / checkbox / radio / hidden", () => {
		loadHTML(`
			<input type="password" name="pw" />
			<input type="email" name="em" />
			<input type="checkbox" name="ck" />
			<input type="radio" name="rd" />
			<input type="hidden" name="hd" />
		`);
		expect(getFillableInputs()).toHaveLength(0);
	});

	it("skips disabled / readonly inputs", () => {
		loadHTML(`
			<input type="text" name="a" />
			<input type="text" name="b" disabled />
			<input type="text" name="c" readonly />
		`);
		const names = getFillableInputs().map((el) => el.getAttribute("name"));
		expect(names).toEqual(["a"]);
	});
});

describe("candidateKind / isAutofillCandidate", () => {
	it("classifies a password input as login", () => {
		loadHTML(`<input type="password" name="pw" />`);
		const el = document.querySelector<HTMLInputElement>("input")!;
		expect(candidateKind(el)).toBe("login");
		expect(isAutofillCandidate(el)).toBe(true);
	});

	it("classifies the detected username input as login", () => {
		loadHTML(`
			<form>
				<input type="text" name="username" />
				<input type="password" name="pw" />
			</form>
		`);
		const username = document.querySelector<HTMLInputElement>('[name="username"]')!;
		expect(candidateKind(username)).toBe("login");
	});

	it("classifies a card field as card (priority over login)", () => {
		loadHTML(`
			<form>
				<input autocomplete="cc-number" name="num" />
				<input autocomplete="cc-csc" type="password" name="cvc" />
			</form>
		`);
		const cvc = document.querySelector<HTMLInputElement>('[name="cvc"]')!;
		expect(candidateKind(cvc)).toBe("card");
	});

	it("classifies a one-time-code field as otp", () => {
		loadHTML(`<input autocomplete="one-time-code" name="code" />`);
		const el = document.querySelector<HTMLInputElement>("input")!;
		expect(candidateKind(el)).toBe("otp");
	});

	it("returns null for unrelated text inputs", () => {
		loadHTML(`<input type="text" name="search" />`);
		const el = document.querySelector<HTMLInputElement>("input")!;
		expect(candidateKind(el)).toBeNull();
		expect(isAutofillCandidate(el)).toBe(false);
	});

	it("returns null for readonly / disabled inputs even when they'd otherwise match", () => {
		loadHTML(`<input type="password" name="pw" readonly />`);
		const el = document.querySelector<HTMLInputElement>("input")!;
		expect(candidateKind(el)).toBeNull();
	});

	it("returns null for non-input targets (event delegation safety)", () => {
		loadHTML(`<button>click</button>`);
		const btn = document.querySelector("button")!;
		expect(candidateKind(btn)).toBeNull();
		expect(isAutofillCandidate(btn)).toBe(false);
		expect(candidateKind(null)).toBeNull();
	});
});
