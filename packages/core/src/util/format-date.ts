import { i18n } from "@lingui/core";

// Format dates with the active app locale (Lingui's i18n instance), not the browser
// default, so they match the rest of the UI. Accept an epoch-ms timestamp or a Date.

/** Localized medium date, e.g. "Jan 13, 2026". */
export function formatDate(value: number | Date): string {
	return i18n.date(typeof value === "number" ? new Date(value) : value, { dateStyle: "medium" });
}

/** Localized medium date + short time, e.g. "Jan 13, 2026, 4:05 PM". */
export function formatDateTime(value: number | Date): string {
	return i18n.date(typeof value === "number" ? new Date(value) : value, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

/**
 * Localized "in 12 minutes" / "in 2 hours" / "in 3 days", rounded to the largest unit that fits.
 *
 * `Intl.RelativeTimeFormat` rather than a hand-rolled plural, because it gets the plural rules of
 * every locale right for free, which a `<Plural>` per unit would only get right for English.
 * `numeric: "always"` on purpose: "auto" produces "next hour", which reads oddly for a countdown.
 */
export function formatIn(ms: number): string {
	const rtf = new Intl.RelativeTimeFormat(i18n.locale, { numeric: "always" });
	const minutes = Math.round(ms / 60_000);
	// Never "in 0 minutes": under a minute is still a wait, and rounding it away reads as a bug.
	if (minutes < 60) return rtf.format(Math.max(1, minutes), "minute");
	const hours = Math.round(minutes / 60);
	if (hours < 24) return rtf.format(hours, "hour");
	return rtf.format(Math.round(hours / 24), "day");
}

/** Localized medium date + time to the second, e.g. "Jan 13, 2026, 4:05:22 PM".
 * For the password changelog, where two rotations can land seconds apart. */
export function formatDateTimeExact(value: number | Date): string {
	return i18n.date(typeof value === "number" ? new Date(value) : value, {
		dateStyle: "medium",
		timeStyle: "medium",
	});
}
