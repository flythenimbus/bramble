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
