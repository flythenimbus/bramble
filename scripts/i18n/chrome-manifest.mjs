// Chrome extension _locales adapter: generates _locales/<code>/messages.json
// from the en source so the manifest's __MSG_*__ placeholders (name stays
// verbatim, description + command labels localize) render per browser locale.
// Idempotent: a target locale that already exists is left alone (manual edits win).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHROME_LOCALES_DIR, LOCALES } from "./locales.mjs";
import { translateText } from "./ollama.mjs";

const SOURCE_DIR = "en";

export async function run() {
	console.log("• Chrome extension _locales");
	const srcPath = join(CHROME_LOCALES_DIR, SOURCE_DIR, "messages.json");
	if (!existsSync(srcPath)) {
		console.log(`  no source ${SOURCE_DIR}/messages.json — skipping`);
		return;
	}
	const src = JSON.parse(readFileSync(srcPath, "utf8"));
	for (const { code, name } of LOCALES) {
		// Chrome locale dirs use underscores (pt_BR), not hyphens.
		const chromeCode = code.replace("-", "_");
		const dir = join(CHROME_LOCALES_DIR, chromeCode);
		const target = join(dir, "messages.json");
		if (existsSync(target)) {
			console.log(`  ${chromeCode}: up to date`);
			continue;
		}
		const out = {};
		for (const [key, entry] of Object.entries(src)) {
			out[key] = { message: await translateText(name, entry.message) };
			if (entry.description) out[key].description = entry.description;
		}
		mkdirSync(dir, { recursive: true });
		writeFileSync(target, `${JSON.stringify(out, null, "\t")}\n`);
		console.log(`  ${chromeCode}: wrote messages.json`);
	}
}
