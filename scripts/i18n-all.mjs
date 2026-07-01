#!/usr/bin/env node
// Translate every localizable surface via local Ollama: web/extension Lingui
// catalogs, iOS fastlane store metadata, the Chrome extension _locales, Android
// string resources, and the iOS String Catalog. Each adapter is idempotent and
// skips work already done.
//
//   node scripts/i18n-all.mjs
//   I18N_MODEL=gemma3:12b node scripts/i18n-all.mjs

import { run as runAndroid } from "./i18n/android-xml.mjs";
import { run as runChromeManifest } from "./i18n/chrome-manifest.mjs";
import { run as runFastlane } from "./i18n/fastlane.mjs";
import { modelInfo } from "./i18n/ollama.mjs";
import { run as runPo } from "./i18n/po.mjs";
import { run as runXcstrings } from "./i18n/xcstrings.mjs";

console.log(`i18n translate — all surfaces (${modelInfo})\n`);
for (const adapter of [runPo, runFastlane, runChromeManifest, runAndroid, runXcstrings]) {
	await adapter();
}
console.log("\ndone");
