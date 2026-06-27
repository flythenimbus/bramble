import { i18n } from "@lingui/core";

// Human-readable names for the locale picker; keys are the catalog locale codes.
export const locales = {
	en: "English",
	de: "Deutsch",
	es: "Español",
	fr: "Français",
	"pt-BR": "Português (Brasil)",
	it: "Italiano",
} as const;

export type Locale = keyof typeof locales;
export const defaultLocale: Locale = "en";

/**
 * Load just the requested locale's compiled catalog and activate it. Dynamic
 * import keeps each language out of the main bundle (only the active one ships).
 */
export async function activateLocale(locale: Locale): Promise<void> {
	// The .ts extension is required so Vite can statically split per-locale chunks.
	const { messages } = await import(`./locales/${locale}/messages.ts`);
	i18n.loadAndActivate({ locale, messages });
}

/**
 * Pick a supported locale from a BCP-47 tag, else default. Tries an exact match
 * first ("pt-BR"), then the bare language matched against any supported locale
 * ("pt" -> "pt-BR", "es-419" -> "es").
 */
export function resolveLocale(tag: string | undefined): Locale {
	const norm = (tag ?? "").toLowerCase();
	const codes = Object.keys(locales) as Locale[];
	const exact = codes.find((c) => c.toLowerCase() === norm);
	if (exact) return exact;
	const base = norm.split("-")[0] ?? "";
	return codes.find((c) => c.toLowerCase().split("-")[0] === base) ?? defaultLocale;
}

export { i18n };
