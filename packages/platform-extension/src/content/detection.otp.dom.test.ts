/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import { otpInputs, splitOtpFields } from "./detection";

// Corpus for issue #47. Before the structural rungs landed, only 4 of these
// detected: the two autocomplete="one-time-code" shapes, GitHub's name="otp",
// and anything containing the word "authenticator" (which happens to survive
// translation into German). Everything else, including every localized
// verification-code phrasing and every untagged segmented widget, returned
// nothing, so the dropdown never offered a code and the user had to copy it by
// hand. Keep adding rows here rather than patching the regex blind.

beforeEach(() => {
	document.body.innerHTML = "";
});

function ids(html: string): string[] {
	document.body.innerHTML = html;
	return otpInputs().map((el) => el.id);
}

function boxes(n: number, attrs: string): string {
	return `<div>${Array.from({ length: n }, (_, i) => `<input id="d${i + 1}" ${attrs}>`).join("")}</div>`;
}

describe("otp: explicit tokens (strongest rung)", () => {
	it("finds a single one-time-code field", () => {
		expect(ids('<input id="a" autocomplete="one-time-code" type="text">')).toEqual(["a"]);
	});

	it("finds every box of a tagged segmented widget", () => {
		expect(ids(boxes(6, 'autocomplete="one-time-code" type="text" maxlength="1"'))).toEqual([
			"d1",
			"d2",
			"d3",
			"d4",
			"d5",
			"d6",
		]);
	});

	// Verbatim from vercel.com's email-code screen: the `input-otp` library that
	// shadcn/ui ships, and the shape behind most React "six boxes" widgets. The
	// boxes are painted divs; the real field is ONE transparent maxlength=6 input
	// absolutely positioned over them. Worth pinning precisely because it looks
	// segmented and isn't: a change that "fixes" segmented detection by splitting
	// on appearance would break it, and the whole code belongs in this one field.
	it("treats a painted-boxes widget as the single field it really is", () => {
		const html =
			'<div style="position:absolute;inset:0;pointer-events:none">' +
			'<input id="a" autocomplete="one-time-code" aria-label="Verification code sent to x@example.com"' +
			' data-1p-ignore="true" data-lpignore="true" data-input-otp="true" inputmode="numeric"' +
			' maxlength="6" value="" name="digits"></div>';
		expect(ids(html)).toEqual(["a"]);
	});
});

describe("otp: attribute and label hints", () => {
	it("finds GitHub's tokenless name=otp", () => {
		expect(ids('<input id="a" name="otp" type="text">')).toEqual(["a"]);
	});

	// Verbatim from login.live.com's code screen, the field issue #47 was filed
	// about. Note there is no autocomplete attribute at all, so the token rung
	// never fires; before the #47 work this field was invisible to us entirely.
	// Three rungs claim it now: `otc` in name/id, "Code" plus maxlength=8, and
	// type=tel plus maxlength=8. Any one of them alone would do.
	const MICROSOFT_OTC =
		'<input id="otc-confirmation-input" data-testid="otc-confirmation-input" name="otc"' +
		' placeholder="Code" type="tel" maxlength="8" aria-label="Enter the code you received"' +
		' aria-describedby="oneTimeCodeDescription" class="ext-input ext-text-box" value="">';

	it("finds Microsoft's live code field", () => {
		expect(ids(MICROSOFT_OTC)).toEqual(["otc-confirmation-input"]);
	});

	it("still finds it when the name is stripped, on shape alone", () => {
		// maxlength=8 is the top of the code-length band; 9 would drop to the
		// abbreviation rung only.
		expect(
			ids(
				MICROSOFT_OTC.replace(' name="otc"', "").replace('id="otc-confirmation-input"', 'id="a"'),
			),
		).toEqual(["a"]);
	});

	it("matches an abbreviation glued to an id by underscores", () => {
		// \b fails between "_" and "O" because both are word characters.
		expect(ids('<input id="idTxtBx_SAOTCC_OTC" type="tel">')).toEqual(["idTxtBx_SAOTCC_OTC"]);
	});

	it.each([
		["de Bestätigungscode", "Bestätigungscode"],
		["de Sicherheitscode", "Sicherheitscode"],
		["de Einmalcode", "Einmalcode"],
		["fr Code de vérification", "Code de vérification"],
		["es Código de verificación", "Código de verificación"],
		["it Codice di verifica", "Codice di verifica"],
		["pt Código de verificação", "Código de verificação"],
		["nl Verificatiecode", "Verificatiecode"],
		["sv Verifieringskod", "Verifieringskod"],
		["sv Engångskod", "Engångskod"],
	])("finds a field labelled %s", (_name, label) => {
		expect(ids(`<label for="a">${label}</label><input id="a" type="text">`)).toEqual(["a"]);
	});

	it("finds an authenticator-app label", () => {
		const html =
			'<label for="a">Enter the code from your authenticator app</label><input id="a" type="text">';
		expect(ids(html)).toEqual(["a"]);
	});
});

describe("otp: bare 'code' needs a code-shaped field behind it", () => {
	it("accepts a short bounded field labelled 'Code'", () => {
		expect(ids('<label for="a">Code</label><input id="a" type="text" maxlength="6">')).toEqual([
			"a",
		]);
	});

	it("accepts 'Enter code' on a bounded field", () => {
		expect(
			ids('<label for="a">Enter code</label><input id="a" type="text" maxlength="6">'),
		).toEqual(["a"]);
	});

	it("rejects 'Code' on an unbounded field", () => {
		// Without a length bound this is as likely to be a discount box.
		expect(ids('<label for="a">Code</label><input id="a" type="text">')).toEqual([]);
	});

	it.each([
		"gift code",
		"referral code",
		"discount code",
		"voucher code",
	])("rejects %s even when bounded", (label) => {
		expect(ids(`<label for="a">${label}</label><input id="a" type="text" maxlength="6">`)).toEqual(
			[],
		);
	});
});

describe("otp: structural rungs (no readable hint at all)", () => {
	it("finds an untagged segmented widget", () => {
		expect(ids(boxes(6, 'name="digit" type="text" maxlength="1" inputmode="numeric"'))).toEqual([
			"d1",
			"d2",
			"d3",
			"d4",
			"d5",
			"d6",
		]);
	});

	it("finds a 4-box widget", () => {
		expect(ids(boxes(4, 'type="text" maxlength="1"'))).toHaveLength(4);
	});

	// Cloudflare's 2FA form sets no maxlength on its boxes at all (bar the first,
	// which takes maxlength=6 so an OS code autofill can drop the whole code in);
	// each box declares its width with pattern="\d{1}" instead.
	it("finds boxes that declare their width with a pattern", () => {
		expect(ids(boxes(6, 'type="text" inputmode="numeric" pattern="\\d{1}"'))).toHaveLength(6);
	});

	it("ignores a run shorter than the minimum", () => {
		// Two or three single-char boxes are more likely a split date or initials.
		expect(ids(boxes(3, 'type="text" maxlength="1"'))).toEqual([]);
	});

	it("finds a lone digits-only field of code length", () => {
		expect(
			ids('<input id="a" type="text" inputmode="numeric" maxlength="6" pattern="[0-9]{6}">'),
		).toEqual(["a"]);
	});

	it("accepts pattern-only evidence", () => {
		expect(ids('<input id="a" type="text" maxlength="6" pattern="\\d{6}">')).toEqual(["a"]);
	});

	it("refuses to guess when several numeric fields qualify", () => {
		const html = '<input id="a" type="tel" maxlength="6"><input id="b" type="tel" maxlength="6">';
		expect(ids(html)).toEqual([]);
	});

	it("ignores a numeric field that is too short to be a code", () => {
		expect(ids('<input id="a" type="tel" maxlength="3" inputmode="numeric">')).toEqual([]);
	});

	it("ignores a long numeric field", () => {
		expect(ids('<input id="a" type="tel" maxlength="16" inputmode="numeric">')).toEqual([]);
	});

	it("does not claim a postal code", () => {
		expect(
			ids(
				'<label for="a">Postal code</label><input id="a" type="tel" maxlength="6" inputmode="numeric">',
			),
		).toEqual([]);
	});

	it("does not claim a German postal code", () => {
		expect(
			ids(
				'<label for="a">Postleitzahl</label><input id="a" type="tel" maxlength="5" inputmode="numeric">',
			),
		).toEqual([]);
	});
});

describe("otp: boxes vs the field holding the whole code", () => {
	function split(html: string) {
		document.body.innerHTML = html;
		const { boxes: b, whole } = splitOtpFields(otpInputs());
		return { boxes: b.map((el) => el.id), whole: whole?.id ?? null };
	}

	it("keeps a segmented widget's hidden mirror out of the boxes", () => {
		// Verbatim shape from Cloudflare's 2FA form: six boxes plus a
		// visually-hidden input carrying the assembled code for the form. It
		// answers the same one-time-code query, and filling it with one character
		// of the code (or with nothing, past the end of it) blanks the widget.
		const html =
			`${boxes(6, 'type="text" autocomplete="one-time-code" pattern="\\d{1}"')}` +
			'<input id="m" type="text" autocomplete="one-time-code" maxlength="6" pattern="\\d{6}" aria-hidden="true" tabindex="-1">';
		expect(split(html)).toEqual({
			boxes: ["d1", "d2", "d3", "d4", "d5", "d6"],
			whole: "m",
		});
	});

	it("reports no mirror when the widget is only boxes", () => {
		const html = boxes(6, 'type="text" autocomplete="one-time-code" maxlength="1"');
		expect(split(html).whole).toBeNull();
	});

	it("treats a lone field as the whole-code field", () => {
		expect(split('<input id="a" autocomplete="one-time-code" type="text">')).toEqual({
			boxes: [],
			whole: "a",
		});
	});

	it("does not call a single box a widget", () => {
		// One box is a field we happened to detect, not something to spread a code
		// across; it takes the code whole.
		expect(split('<input id="a" autocomplete="one-time-code" type="text" maxlength="1">')).toEqual({
			boxes: [],
			whole: "a",
		});
	});
});

describe("otp: does not fire on ordinary login forms", () => {
	it("ignores a plain username + password form", () => {
		const html = `<form>
			<input id="u" name="username" type="text" autocomplete="username">
			<input id="p" name="password" type="password" autocomplete="current-password">
		</form>`;
		expect(ids(html)).toEqual([]);
	});

	it("leaves a CVV to the card scan", () => {
		const html = `<form>
			<input id="num" name="cardnumber" autocomplete="cc-number" type="text">
			<input id="cvv" name="cvv" autocomplete="cc-csc" type="tel" maxlength="4" inputmode="numeric">
		</form>`;
		expect(ids(html)).toEqual([]);
	});
});
