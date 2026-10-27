import { api } from "./content-api";

// Localized UI string from the extension's _locales catalog. Keys off the browser
// locale (the same one LocaleGate resolves for the app) and auto-falls back to the
// `en` default_locale when a locale lacks the key. getMessage is synchronous and
// available to content scripts without a permission, so this stays flat (no chunk).
export function t(key: string): string {
	return api.i18n.getMessage(key);
}
