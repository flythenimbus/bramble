/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture } from "../fixtures/load";
import { invalidatePageFields } from "./field-model";
import { fillCard, fillCustomFields } from "./fill";

const MASTERCARD = {
	kind: "card" as const,
	cardholderName: "J AVERY",
	number: "5555555555554444",
	expMonth: "1",
	expYear: "2030",
	cvv: "111",
};

const VISA = {
	kind: "card" as const,
	cardholderName: "R AVERY",
	number: "4111111111111111",
	expMonth: "7",
	expYear: "2029",
	cvv: "559",
};

const field = (name: string): HTMLInputElement =>
	document.querySelector<HTMLInputElement>(`[name="${name}"]`)!;

/** jsdom has no layout, so every box is 0x0 and isRendered() would reject every field. */
function layOutInputs(): void {
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
}

beforeEach(() => {
	layOutInputs();
	document.body.innerHTML = `
		<form>
			<input name="card_number" />
			<input name="cardholder" />
			<input name="expiry" />
			<input name="cvv" />
		</form>`;
	invalidatePageFields();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("fillCard — switching cards in the dropdown", () => {
	it("replaces the first card when a second is picked", () => {
		// The reported bug: expiry and CVV kept the first card's values, so picking
		// the second entry looked like it had filled the wrong one.
		expect(fillCard(MASTERCARD, false)).toBe(true);
		expect(fillCard(VISA, false)).toBe(true);
		expect(field("card_number").value).toBe("4111111111111111");
		expect(field("cardholder").value).toBe("R AVERY");
		expect(field("expiry").value).toBe("07/29");
		expect(field("cvv").value).toBe("559");
	});

	it("leaves an auto-fill alone once a field has been filled", () => {
		// The reason the set exists: a re-query must not re-clobber a field the
		// user cleared after an auto-fill.
		expect(fillCard(MASTERCARD, true)).toBe(true);
		field("cvv").value = "";
		expect(fillCard(VISA, true)).toBe(false);
		expect(field("expiry").value).toBe("01/30");
		expect(field("cvv").value).toBe("");
	});

	it("still overwrites what the user typed on an explicit pick", () => {
		field("cvv").value = "000";
		expect(fillCard(VISA, false)).toBe(true);
		expect(field("cvv").value).toBe("559");
	});

	it("never writes into a field the form has hidden", () => {
		// A PAN-only PCI capture frame keeps a display:none cvc box that its submit
		// handler still forwards, so filling it would send a CVV the page never asked
		// for. Hiding a box takes it out of the flow.
		document.body.innerHTML = `
			<form>
				<input name="card_number" />
				<input name="cvv" style="display: none" />
			</form>`;
		invalidatePageFields();
		expect(fillCard(VISA, false)).toBe(true);
		expect(field("card_number").value).toBe("4111111111111111");
		expect(field("cvv").value).toBe("");
	});
});

// Paymentus, and most enterprise checkouts: the expiry is two dropdowns, not two text boxes.
// Before this the pair was invisible to detection, so the card filled with no expiry at all and
// the form came back "Expiration Date is missing".
const MONTHS = `<option value="">MM</option>${Array.from(
	{ length: 12 },
	(_, i) =>
		`<option value="${String(i + 1).padStart(2, "0")}">${String(i + 1).padStart(2, "0")} - Month</option>`,
).join("")}`;

function loadSelectExpiry(monthOptions = MONTHS, yearOptions?: string): void {
	const years =
		yearOptions ??
		`<option value="">YYYY</option>${[2026, 2029, 2030, 2031].map((y) => `<option value="${y}">${y}</option>`).join("")}`;
	document.body.innerHTML = `
		<form>
			<input name="cardNumber" autocomplete="cc-number" />
			<input name="cardHolderName" autocomplete="cc-name" />
			<select name="expiryDateMonth" autocomplete="cc-exp-month">${monthOptions}</select>
			<select name="expiryDateYear" autocomplete="cc-exp-year">${years}</select>
			<input name="cvv" type="password" autocomplete="cc-csc" />
		</form>`;
	invalidatePageFields();
}

const chosen = (name: string): string =>
	document.querySelector<HTMLSelectElement>(`select[name="${name}"]`)!.value;

describe("fillCard — an expiry the form asks you to choose", () => {
	it("selects the month and year options", () => {
		loadSelectExpiry();
		expect(fillCard(MASTERCARD, false)).toBe(true);
		expect(chosen("expiryDateMonth")).toBe("01");
		expect(chosen("expiryDateYear")).toBe("2030");
		expect(field("cardNumber").value).toBe("5555555555554444");
	});

	it("fires change, which is what the form's own validation listens for", () => {
		loadSelectExpiry();
		const month = document.querySelector<HTMLSelectElement>('[name="expiryDateMonth"]')!;
		const events: string[] = [];
		for (const type of ["input", "change"]) {
			month.addEventListener(type, () => events.push(type));
		}
		fillCard(MASTERCARD, false);
		expect(events).toEqual(["input", "change"]);
	});

	it("takes an unpadded month when that is what the options offer", () => {
		loadSelectExpiry(
			`<option value="">MM</option>${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("")}`,
		);
		fillCard(VISA, false);
		expect(chosen("expiryDateMonth")).toBe("7");
	});

	it("takes a two-digit year when that is what the options offer", () => {
		loadSelectExpiry(
			MONTHS,
			`<option value="">YY</option>${[29, 30, 31].map((y) => `<option value="${y}">${y}</option>`).join("")}`,
		);
		fillCard(VISA, false);
		expect(chosen("expiryDateYear")).toBe("29");
	});

	it("matches on the option's text when its value is a code of the site's own", () => {
		loadSelectExpiry(
			`<option value="">MM</option><option value="m7">07 - July</option><option value="m1">01 - January</option>`,
		);
		fillCard(VISA, false);
		expect(chosen("expiryDateMonth")).toBe("m7");
	});

	it("leaves a select alone when it offers nothing that matches", () => {
		// A select holding a value it never offered reads as the placeholder to the form, and the
		// user is shown no error: worse than not filling it.
		loadSelectExpiry(MONTHS, `<option value="">YYYY</option><option value="2040">2040</option>`);
		expect(fillCard(VISA, false)).toBe(true);
		expect(chosen("expiryDateYear")).toBe("");
		expect(chosen("expiryDateMonth")).toBe("07");
	});
});

describe("fillCustomFields — switching entries", () => {
	beforeEach(() => {
		document.body.innerHTML = `
			<form>
				<input name="card_number" />
				<input name="expiry" />
				<input name="cvv" />
				<input name="billing_zip" />
			</form>`;
		invalidatePageFields();
	});

	it("skips a hidden input rather than spilling into it", () => {
		document.body.innerHTML = `
			<form>
				<input name="card_number" />
				<input name="billing_zip" style="display: none" />
			</form>`;
		invalidatePageFields();
		fillCustomFields([{ key: "billing zip", value: "K1A 0B1" }], false);
		expect(field("billing_zip").value).toBe("");
	});

	it("replaces a value it wrote for the previous entry", () => {
		fillCustomFields([{ key: "billing zip", value: "M5V 2T6" }], false);
		expect(field("billing_zip").value).toBe("M5V 2T6");
		fillCustomFields([{ key: "billing zip", value: "K1A 0B1" }], false);
		expect(field("billing_zip").value).toBe("K1A 0B1");
	});

	it("never clobbers a value the user typed", () => {
		field("billing_zip").value = "typed by hand";
		fillCustomFields([{ key: "billing zip", value: "K1A 0B1" }], false);
		expect(field("billing_zip").value).toBe("typed by hand");
	});
});

describe("fillCard — the Semafone PAN-only capture frame", () => {
	beforeEach(() => {
		layOutInputs();
		loadFixture("semafone-card-frame");
		invalidatePageFields();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("fills the pan box and leaves the disabled cvc empty", () => {
		// The frame tokenises the PAN only. Its cvc box is display:none, but the submit
		// handler still appends sf.req.card.securityCode when it holds a value, so a
		// fill there would put the CVV into a request that was not collecting one.
		expect(fillCard(VISA, false)).toBe(true);
		expect(document.querySelector<HTMLInputElement>("#pan")!.value).toBe("4111111111111111");
		expect(document.querySelector<HTMLInputElement>("#cvc")!.value).toBe("");
	});
});
