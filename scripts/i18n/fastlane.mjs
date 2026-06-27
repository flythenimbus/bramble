// iOS fastlane metadata adapter: generates metadata/<appStore>/ dirs from the
// en-US source so `deliver` uploads localized App Store listings. Idempotent: a
// target file that already exists is left alone (manual edits win).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FASTLANE_DIR, LOCALES, SOURCE } from "./locales.mjs";
import { translateText } from "./ollama.mjs";

const SOURCE_DIR = "en-US";
// Prose files worth translating.
const PROSE = new Set(["description.txt", "promotional_text.txt", "release_notes.txt", "subtitle.txt"]);
// Brand name and URLs are copied verbatim.
const VERBATIM = new Set(["name.txt", "privacy_url.txt", "support_url.txt"]);
// keywords.txt: comma-separated, hard 100-char App Store cap — special handling.
const KEYWORDS = "keywords.txt";

export async function run() {
	console.log("• iOS fastlane metadata");
	const src = join(FASTLANE_DIR, SOURCE_DIR);
	if (!existsSync(src)) {
		console.log(`  no source dir ${SOURCE_DIR} — skipping`);
		return;
	}
	const files = readdirSync(src).filter((f) => f.endsWith(".txt"));
	for (const { code, name, appStore } of LOCALES) {
		const dir = join(FASTLANE_DIR, appStore);
		mkdirSync(dir, { recursive: true });
		let wrote = 0;
		for (const file of files) {
			const target = join(dir, file);
			if (existsSync(target)) continue; // don't clobber existing/edited translations
			const en = readFileSync(join(src, file), "utf8");
			let value;
			if (VERBATIM.has(file)) value = en;
			else if (file === KEYWORDS) value = await translateKeywords(name, en);
			else if (PROSE.has(file)) value = await translateText(name, en);
			else value = en; // unknown file: copy through
			writeFileSync(target, value);
			wrote++;
		}
		console.log(`  ${appStore}: ${wrote ? `wrote ${wrote} file(s)` : "up to date"}`);
	}
}

async function translateKeywords(language, csv) {
	const out = await translateText(
		language,
		csv,
		"This is a comma-separated App Store keyword list. Translate each keyword, keep it comma-separated, drop none, and keep brand/standard terms untranslated.",
	);
	const clean = out.replace(/\s*,\s*/g, ",").trim();
	if (clean.length > 100) {
		console.warn(`    keywords too long (${clean.length}>100) for ${language}; trim manually`);
	}
	return clean;
}
