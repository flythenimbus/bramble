import { describe, expect, it } from "vitest";
import {
	cardBrand,
	cardCvvIssue,
	cardDigits,
	cardExpMonthIssue,
	cardExpYearIssue,
	cardNumberIssue,
	luhnValid,
} from "./card";

// The vendors' own published test numbers: every one is a real, checksum-valid
// number of the length that brand actually issues.
const VISA_16 = "4242424242424242";
const VISA_13 = "4222222222222";
const MASTERCARD = "5555555555554444";
const AMEX = "378282246310005";
const DISCOVER = "6011111111111117";
// Diners Club: 14 digits, and cardBrand does not recognise the prefix.
const DINERS = "30569309025904";

describe("luhnValid", () => {
	it("accepts the vendors' test numbers", () => {
		for (const n of [VISA_16, VISA_13, MASTERCARD, AMEX, DISCOVER, DINERS]) {
			expect(luhnValid(n), n).toBe(true);
		}
	});

	it("rejects a single transposed digit", () => {
		expect(luhnValid("4242424242424241")).toBe(false);
	});

	it("rejects an empty string rather than treating it as a zero sum", () => {
		expect(luhnValid("")).toBe(false);
	});
});

describe("cardDigits", () => {
	it("strips the separators people actually type", () => {
		expect(cardDigits("4242 4242 4242 4242")).toBe(VISA_16);
		expect(cardDigits("4242-4242-4242-4242")).toBe(VISA_16);
	});
});

describe("cardNumberIssue", () => {
	it("accepts the vendors' test numbers", () => {
		for (const n of [VISA_16, VISA_13, MASTERCARD, AMEX, DISCOVER]) {
			expect(cardNumberIssue(n), n).toBeNull();
		}
	});

	it("accepts a grouped number", () => {
		expect(cardNumberIssue("4242 4242 4242 4242")).toBeNull();
		expect(cardNumberIssue("3782 822463 10005")).toBeNull();
	});

	it("accepts an issuer we cannot identify, on the checksum alone", () => {
		// 14 digits and no brand match, so only the generic range and Luhn apply.
		expect(cardBrand(DINERS)).toBeUndefined();
		expect(cardNumberIssue(DINERS)).toBeNull();
	});

	it("treats empty as the form's business, not ours", () => {
		expect(cardNumberIssue("")).toBeNull();
		expect(cardNumberIssue("   ")).toBeNull();
	});

	it("rejects the over-long number that prompted this", () => {
		// 17 digits, Visa prefix: right checksum family, wrong length for the brand.
		expect(cardNumberIssue("42424242424242424")).toBe("brand-length");
	});

	it("rejects a length no issuer uses", () => {
		expect(cardNumberIssue("42424242424")).toBe("length"); // 11
		expect(cardNumberIssue("42424242424242424242")).toBe("length"); // 20
	});

	it("rejects a brand-specific length mismatch", () => {
		expect(cardNumberIssue("37828224631000")).toBe("brand-length"); // Amex, 14
		expect(cardNumberIssue("555555555555444")).toBe("brand-length"); // Mastercard, 15
	});

	it("rejects anything that is not a digit or a separator", () => {
		expect(cardNumberIssue("4242 4242 4242 424a")).toBe("non-digit");
		expect(cardNumberIssue("4242.4242.4242.4242")).toBe("non-digit");
	});

	it("rejects a right-length number that fails the checksum", () => {
		expect(cardNumberIssue("4242424242424243")).toBe("checksum");
	});

	it("reports the length problem before the checksum", () => {
		// A too-short number usually fails Luhn too; the length message is the useful one.
		expect(cardNumberIssue("1234")).toBe("length");
	});
});

describe("cardExpMonthIssue", () => {
	it("accepts every real month, padded or not", () => {
		for (const m of ["1", "01", "9", "09", "10", "11", "12"]) {
			expect(cardExpMonthIssue(m), m).toBeNull();
		}
	});

	it("treats empty as the form's business", () => {
		expect(cardExpMonthIssue("")).toBeNull();
	});

	it("rejects a month that does not exist", () => {
		expect(cardExpMonthIssue("0")).toBe("range");
		expect(cardExpMonthIssue("00")).toBe("range");
		expect(cardExpMonthIssue("13")).toBe("range");
		expect(cardExpMonthIssue("99")).toBe("range");
	});

	it("rejects anything that is not one or two digits", () => {
		expect(cardExpMonthIssue("ab")).toBe("non-digit");
		expect(cardExpMonthIssue("1.5")).toBe("non-digit");
		expect(cardExpMonthIssue("012")).toBe("non-digit");
	});
});

describe("cardExpYearIssue", () => {
	it("accepts two-digit and full 20xx years", () => {
		for (const y of ["30", "00", "99", "2030", "2000", "2099"]) {
			expect(cardExpYearIssue(y), y).toBeNull();
		}
	});

	it("treats empty as the form's business", () => {
		expect(cardExpYearIssue("")).toBeNull();
	});

	it("rejects a length no card uses", () => {
		expect(cardExpYearIssue("3")).toBe("length");
		expect(cardExpYearIssue("203")).toBe("length");
		expect(cardExpYearIssue("20300")).toBe("length");
	});

	it("rejects a full year outside the plausible century", () => {
		expect(cardExpYearIssue("1999")).toBe("range");
		expect(cardExpYearIssue("2100")).toBe("range");
	});

	it("rejects non-digits", () => {
		expect(cardExpYearIssue("20a0")).toBe("non-digit");
	});
});

describe("cardCvvIssue", () => {
	it("accepts three and four digits", () => {
		expect(cardCvvIssue("123")).toBeNull();
		expect(cardCvvIssue("1234")).toBeNull();
		expect(cardCvvIssue("007")).toBeNull();
	});

	it("treats empty as the form's business", () => {
		expect(cardCvvIssue("")).toBeNull();
	});

	it("rejects a length no card uses", () => {
		expect(cardCvvIssue("12")).toBe("length");
		expect(cardCvvIssue("12345")).toBe("length");
	});

	it("rejects non-digits", () => {
		expect(cardCvvIssue("12a")).toBe("non-digit");
		expect(cardCvvIssue("1 2")).toBe("non-digit");
	});
});
