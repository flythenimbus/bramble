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
