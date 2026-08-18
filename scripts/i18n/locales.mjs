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
// iOS (App Store) fastlane metadata, under the repo-root fastlane/ in an `ios/` subdir so it sits
// beside Android's. The Fastfile hands this exact path to deliver; deliver's default
// (fastlane/metadata) would reject the non-locale `ios` child.
export const FASTLANE_DIR = repo("fastlane/metadata/ios");
// Android store-listing metadata, in fastlane's supply layout: `<root>/fastlane/metadata/android/
// <locale>/`, which is where every tool that consumes it looks. Locale dirs reuse the iOS
// `appStore` codes; en-US is hand-authored and the rest are AI-translated from it, see
// scripts/i18n/android-fastlane.mjs.
export const ANDROID_FASTLANE_DIR = repo("fastlane/metadata/android");
// Chrome extension _locales dir (bundled from public/). Chrome locale codes use
// underscores (pt_BR), unlike the App Store's hyphens.
export const CHROME_LOCALES_DIR = repo("packages/platform-extension/public/_locales");
export const ANDROID_RES = repo("packages/platform-mobile/android/app/src/main/res");
// Web store listings (Chrome Web Store + AMO). <store>/<code>/*.txt; en is the source.
export const STORE_DIR = repo("packages/platform-extension/store");
// Tauri desktop native chrome (tray menu, macOS menu bar): flat <code>.json embedded in the
// binary. Its own surface rather than part of the Lingui catalogs because this chrome is drawn
// before any webview exists and outlives every webview on Wayland. See src-tauri/src/i18n.rs.
export const TAURI_LOCALES_DIR = repo("packages/platform-desktop/src-tauri/locales");
// iOS String Catalog for the autofill extension UI.
export const XCSTRINGS = repo(
	"packages/platform-mobile/ios/App/AutoFillProbe/Localizable.xcstrings",
);
