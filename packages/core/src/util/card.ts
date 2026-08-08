import { z } from "zod";

/**
 * Best-effort payment-card issuer detection from the leading digits (for icon,
 * search, importer tagging). Not validation: an unknown prefix yields no brand.
 */
export function cardBrand(number: string): string | undefined {
	const n = number.replace(/\D/g, "");
	if (/^4/.test(n)) return "Visa";
	if (/^(5[1-5]|2[2-7])/.test(n)) return "Mastercard";
	if (/^3[47]/.test(n)) return "Amex";
	if (/^6(?:011|5)/.test(n)) return "Discover";
	return undefined;
}

/** Digits only. Card numbers are commonly written, and pasted, in groups. */
export function cardDigits(number: string): string {
	return number.replace(/\D/g, "");
}

// ISO/IEC 7812 allows up to 19; nothing in circulation as a payment card is
// shorter than 12. Deliberately wider than the brands below, so an issuer we
// cannot identify is still accepted on the checksum alone.
const MIN_CARD_DIGITS = 12;
const MAX_CARD_DIGITS = 19;

/** Longest string worth accepting in an input: 19 digits plus group separators. */
export const CARD_NUMBER_MAX_INPUT = 23;

// Only for brands cardBrand() actually identifies, and only lengths those brands
// really issue. An unrecognised prefix is not length-checked at all.
const BRAND_LENGTHS: Record<string, readonly number[]> = {
	Visa: [13, 16, 19],
	Mastercard: [16],
	Amex: [15],
	Discover: [16, 19],
};

/** The mod-10 checksum every payment card satisfies. */
export function luhnValid(digits: string): boolean {
	if (!digits) return false;
	let sum = 0;
	let double = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		const d = digits.charCodeAt(i) - 48;
		if (d < 0 || d > 9) return false;
		let v = d;
		if (double) {
			v *= 2;
			if (v > 9) v -= 9;
		}
		sum += v;
		double = !double;
	}
	return sum % 10 === 0;
}

export type CardNumberIssue = "non-digit" | "length" | "brand-length" | "checksum";

// Issues carry the code rather than prose: the message a user reads is localized at
// the call site, so the schema stays free of UI strings. `abort` keeps the checks
// ordered, so a too-short number reports its length instead of the checksum failure
// that a wrong length also causes.
type CardIssue = CardNumberIssue | CardExpMonthIssue | CardExpYearIssue | CardCvvIssue;
const fails = (code: CardIssue) => ({ error: code, abort: true }) as const;

/**
 * A payment card number as a person writes it: separators tolerated, checksum
 * enforced. Non-empty by design; whether a card must carry a number at all is the
 * form's decision, so use `cardNumberIssue` for an optional field.
 */
export const CardNumberSchema = z
	.string()
	.trim()
	.min(1)
	// Spaces and dashes are how people write them; anything else is a typo.
	.refine((v) => !/[^\d\s-]/.test(v), fails("non-digit"))
	.refine((v) => {
		const n = cardDigits(v).length;
		return n >= MIN_CARD_DIGITS && n <= MAX_CARD_DIGITS;
	}, fails("length"))
	.refine((v) => {
		const digits = cardDigits(v);
		const lengths = BRAND_LENGTHS[cardBrand(digits) ?? ""];
		return !lengths || lengths.includes(digits.length);
	}, fails("brand-length"))
	.refine((v) => luhnValid(cardDigits(v)), fails("checksum"));

/** What is wrong with a card number, or null when it is plausible (or empty). */
export function cardNumberIssue(number: string): CardNumberIssue | null {
	return issueOf(CardNumberSchema, number, "checksum");
}

/** Runs a field schema over a trimmed value, treating empty as nothing to check. */
function issueOf<T extends string>(
	schema: z.ZodType<string>,
	value: string,
	fallback: T,
): T | null {
	if (!value?.trim()) return null;
	const result = schema.safeParse(value);
	if (result.success) return null;
	return (result.error.issues[0]?.message ?? fallback) as T;
}

export type CardExpMonthIssue = "non-digit" | "range";
export type CardExpYearIssue = "non-digit" | "length" | "range";
export type CardCvvIssue = "non-digit" | "length";

// Cards carry a 4-digit year only as "20xx"; anything else is a typo rather than an
// issuer we have not heard of.
const MIN_FULL_YEAR = 2000;
const MAX_FULL_YEAR = 2099;

/** Expiry month, written as 1-12 or zero-padded. */
export const CardExpMonthSchema = z
	.string()
	.trim()
	.min(1)
	.refine((v) => /^\d{1,2}$/.test(v), fails("non-digit"))
	.refine((v) => {
		const m = Number(v);
		return m >= 1 && m <= 12;
	}, fails("range"));

/** Expiry year, either two digits or a full 20xx. */
export const CardExpYearSchema = z
	.string()
	.trim()
	.min(1)
	.refine((v) => /^\d+$/.test(v), fails("non-digit"))
	.refine((v) => v.length === 2 || v.length === 4, fails("length"))
	.refine((v) => {
		if (v.length === 2) return true;
		const y = Number(v);
		return y >= MIN_FULL_YEAR && y <= MAX_FULL_YEAR;
	}, fails("range"));

/**
 * Security code: three digits, four on Amex. Not cross-checked against the card
 * number, which may be blank or from an issuer we cannot identify, so the length is
 * accepted as a range rather than pinned to a brand we might have guessed wrong.
 */
export const CardCvvSchema = z
	.string()
	.trim()
	.min(1)
	.refine((v) => /^\d+$/.test(v), fails("non-digit"))
	.refine((v) => v.length === 3 || v.length === 4, fails("length"));

/** What is wrong with an expiry month, or null when it is plausible (or empty). */
export function cardExpMonthIssue(month: string): CardExpMonthIssue | null {
	return issueOf(CardExpMonthSchema, month, "range");
}

/** What is wrong with an expiry year, or null when it is plausible (or empty). */
export function cardExpYearIssue(year: string): CardExpYearIssue | null {
	return issueOf(CardExpYearSchema, year, "range");
}

/** What is wrong with a security code, or null when it is plausible (or empty). */
export function cardCvvIssue(cvv: string): CardCvvIssue | null {
	return issueOf(CardCvvSchema, cvv, "length");
}
