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

// The language chosen in Settings (#163), kept on this device like the theme: read before first
// paint, so it cannot wait on async storage. Absent means "follow the system".
const LANGUAGE_KEY = "bramble-language";

function isLocale(v: string | null): v is Locale {
	return v !== null && Object.hasOwn(locales, v);
}

/** The language chosen in Settings, or null to follow the system. */
export function chosenLanguage(): Locale | null {
	try {
		const stored = localStorage.getItem(LANGUAGE_KEY);
		return isLocale(stored) ? stored : null;
	} catch {
		return null;
	}
}

export function setChosenLanguage(locale: Locale | null): void {
	try {
		if (locale) localStorage.setItem(LANGUAGE_KEY, locale);
		else localStorage.removeItem(LANGUAGE_KEY);
	} catch {}
}

/** The locale to show: the one chosen in Settings, else the best match for the system's tag. */
export function localeFor(systemTag: string | undefined): Locale {
	return chosenLanguage() ?? resolveLocale(systemTag);
}

// The system's tag as LocaleGate saw it, so going back to "System" in Settings needs no reload.
let systemTag: string | undefined;

export function rememberSystemTag(tag: string | undefined): void {
	systemTag = tag;
}

export function systemLocaleTag(): string | undefined {
	return systemTag;
}

export { i18n };
