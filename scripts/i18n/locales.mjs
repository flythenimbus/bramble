import { resolve } from "node:path";

// One source of truth for every translation target. `code` is the Lingui/web
// catalog code; `appStore` / `android` map it to each platform's locale-dir
// convention (App Store full codes, Android `values-<qualifier>`). `name` is the
// language name fed to the model.
export const SOURCE = "en";

export const LOCALES = [
	{ code: "de", name: "German", appStore: "de-DE", android: "de" },
	{ code: "es", name: "Spanish", appStore: "es-ES", android: "es" },
	{ code: "fr", name: "French", appStore: "fr-FR", android: "fr" },
	{ code: "pt-BR", name: "Brazilian Portuguese", appStore: "pt-BR", android: "pt-rBR" },
	{ code: "it", name: "Italian", appStore: "it", android: "it" },
];

const ROOT = resolve(import.meta.dirname, "../..");
export const repo = (...p) => resolve(ROOT, ...p);

// Per-surface source locations.
export const PO_CATALOG = (code) => repo(`packages/core/src/locales/${code}/messages.po`);
export const FASTLANE_DIR = repo("packages/platform-mobile/ios/App/fastlane/metadata");
// Android (F-Droid) fastlane metadata. MUST stay at the repo root: fdroidserver only scans
// `<root>/fastlane/metadata/android/<locale>/` and `<root>/src/<flavor>/fastlane/...`
// (update.py), so a nested path leaves the F-Droid listing with no name/summary/description.
// Locale dirs reuse the iOS `appStore` codes; en-US is hand-authored and the rest are
// AI-translated from it, see scripts/i18n/android-fastlane.mjs.
export const ANDROID_FASTLANE_DIR = repo("fastlane/metadata/android");
// Chrome extension _locales dir (bundled from public/). Chrome locale codes use
// underscores (pt_BR), unlike the App Store's hyphens.
export const CHROME_LOCALES_DIR = repo("packages/platform-extension/public/_locales");
export const ANDROID_RES = repo("packages/platform-mobile/android/app/src/main/res");
// Web store listings (Chrome Web Store + AMO). <store>/<code>/*.txt; en is the source.
export const STORE_DIR = repo("packages/platform-extension/store");
// iOS String Catalog for the autofill extension UI.
export const XCSTRINGS = repo(
	"packages/platform-mobile/ios/App/AutoFillProbe/Localizable.xcstrings",
);
