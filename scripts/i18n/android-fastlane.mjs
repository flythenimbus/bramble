// Android (F-Droid) fastlane metadata. English (en-US) is the hand-authored source of
// truth for the Android listing; the other locales are AI-translated from it, idempotently (an
// existing target file is left alone, so manual edits and prior translations win). This mirrors the
// iOS adapter (fastlane.mjs); the difference is that Android's English is written FOR Android
// (e.g. "your browser", "fingerprint or face") rather than projected from the iOS listing.
//
// Run via `pnpm i18n:native` (translation needs Ollama running, or a DEEPSEEK_API_KEY). After
// editing the English, delete a locale's file to have it re-translated on the next run.
//
//   en-US/title.txt               brand name, copied verbatim
//   en-US/short_description.txt   Play summary (<=80 chars), translated
//   en-US/full_description.txt    translated
//   en-US/changelogs/current.txt  hand-authored, en-US only (snapshotted to <versionCode>.txt at
//                                 release; the client falls back to en-US for other locales)

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ANDROID_FASTLANE_DIR, LOCALES, repo } from "./locales.mjs";
import { translateText } from "./ollama.mjs";

const SOURCE = "en-US";
const VERBATIM = new Set(["title.txt"]); // brand name — copied as-is
const TXT = ["title.txt", "short_description.txt", "full_description.txt"];
const ICON_SRC = repo(
	"packages/platform-mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon~ios-marketing.png",
);

export async function run() {
	console.log("• Android fastlane metadata");
	const src = join(ANDROID_FASTLANE_DIR, SOURCE);
	if (!existsSync(src)) {
		console.log("  no en-US source — author it first");
		return;
	}
	for (const { name, appStore } of LOCALES) {
		const dst = join(ANDROID_FASTLANE_DIR, appStore);
		mkdirSync(dst, { recursive: true });
		let wrote = 0;
		for (const file of TXT) {
			const from = join(src, file);
			const target = join(dst, file);
			if (!existsSync(from) || existsSync(target)) continue; // don't clobber existing translations
			const en = readFileSync(from, "utf8");
			writeFileSync(target, VERBATIM.has(file) ? en : await translateText(name, en));
			wrote++;
		}
		console.log(`  ${appStore}: ${wrote ? `wrote ${wrote} file(s)` : "up to date"}`);
	}
	// Icon (once). F-Droid otherwise falls back to the APK launcher icon.
	const iconDst = join(ANDROID_FASTLANE_DIR, SOURCE, "images", "icon.png");
	if (!existsSync(iconDst) && existsSync(ICON_SRC)) {
		mkdirSync(join(ANDROID_FASTLANE_DIR, SOURCE, "images"), { recursive: true });
		copyFileSync(ICON_SRC, iconDst);
		console.log("  en-US/images/icon.png: seeded from the App Store marketing icon");
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await run();
