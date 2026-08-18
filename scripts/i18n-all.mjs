#!/usr/bin/env node
// Translate every localizable surface via local Ollama: web/extension Lingui
// catalogs, iOS fastlane store metadata, the Chrome extension _locales, Android
// string resources, the iOS String Catalog, the desktop app's native menus, and the
// web store listings. Each
// adapter is idempotent and skips work already done.
//
//   node scripts/i18n-all.mjs
//   I18N_MODEL=gemma3:12b node scripts/i18n-all.mjs

import { run as runAndroid } from "./i18n/android-xml.mjs";
import { run as runAndroidFastlane } from "./i18n/android-fastlane.mjs";
import { run as runChromeManifest } from "./i18n/chrome-manifest.mjs";
import { run as runFastlane } from "./i18n/fastlane.mjs";
import { modelInfo } from "./i18n/ollama.mjs";
import { run as runPo } from "./i18n/po.mjs";
import { run as runStores } from "./i18n/store-listings.mjs";
import { run as runTauriMenus } from "./i18n/tauri-menus.mjs";
import { run as runXcstrings } from "./i18n/xcstrings.mjs";

console.log(`i18n translate — all surfaces (${modelInfo})\n`);
// runAndroidFastlane projects the iOS fastlane copy, so it must follow runFastlane.
for (const adapter of [runPo, runFastlane, runAndroidFastlane, runChromeManifest, runAndroid, runXcstrings, runTauriMenus, runStores]) {
	await adapter();
}
console.log("\ndone");
