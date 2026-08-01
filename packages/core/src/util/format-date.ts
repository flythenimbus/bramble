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

/** Localized medium date + time to the second, e.g. "Jan 13, 2026, 4:05:22 PM".
 * For the password changelog, where two rotations can land seconds apart. */
export function formatDateTimeExact(value: number | Date): string {
	return i18n.date(typeof value === "number" ? new Date(value) : value, {
		dateStyle: "medium",
		timeStyle: "medium",
	});
}
