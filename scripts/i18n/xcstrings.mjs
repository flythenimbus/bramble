// iOS String Catalog (.xcstrings) adapter. The catalog is JSON: each key holds
// per-language "localizations". We fill missing target-language entries from the
// source value. No-ops until the Swift UI is migrated off hardcoded Text() to a
// String Catalog (see notes in the i18n plan). Idempotent.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { LOCALES, SOURCE, XCSTRINGS } from "./locales.mjs";
import { translateBatch } from "./ollama.mjs";

const unit = (value) => ({ stringUnit: { state: "translated", value } });

export async function run() {
	console.log("• iOS String Catalog (.xcstrings)");
	if (!existsSync(XCSTRINGS)) {
		console.log("  no Localizable.xcstrings yet (migrate Swift UI first) — skipping");
		return;
	}
	const cat = JSON.parse(readFileSync(XCSTRINGS, "utf8"));
	const src = cat.sourceLanguage ?? SOURCE;
	const keys = Object.keys(cat.strings ?? {});

	for (const { code, name } of LOCALES) {
		// A key needs translating when it has no localization for this locale.
		const pending = keys.filter((k) => {
			const loc = cat.strings[k].localizations ?? {};
			return !loc[code];
		});
		if (!pending.length) {
			console.log(`  ${code}: up to date`);
			continue;
		}
		// Source text is the key itself unless an explicit source localization exists.
		const sources = pending.map(
			(k) => cat.strings[k].localizations?.[src]?.stringUnit?.value ?? k,
		);
		console.log(`  ${code}: translating ${pending.length}…`);
		const translated = await translateBatch(name, sources);
		pending.forEach((k, i) => {
			const entry = cat.strings[k];
			entry.localizations = entry.localizations ?? {};
			entry.localizations[code] = unit(translated[i]);
		});
		console.log(`  ${code}: wrote ${pending.length}`);
	}
	writeFileSync(XCSTRINGS, `${JSON.stringify(cat, null, 2)}\n`);
}
