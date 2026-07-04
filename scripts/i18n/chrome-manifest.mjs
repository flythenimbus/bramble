// Chrome extension _locales adapter: generates _locales/<code>/messages.json from
// the en source so the manifest's __MSG_*__ placeholders and the content-script UI
// (via browser.i18n.getMessage) render per browser locale. Incremental: only keys
// missing from a target locale are translated; existing translations are kept
// (manual edits win) and the file is rewritten in source-key order, dropping keys
// no longer in en. Run after editing en/messages.json, before bundling.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHROME_LOCALES_DIR, LOCALES } from "./locales.mjs";
import { translateBatch } from "./ollama.mjs";

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
		const existing = existsSync(target) ? JSON.parse(readFileSync(target, "utf8")) : {};

		const missing = Object.keys(src).filter((key) => !existing[key]?.message);
		const filled = {};
		if (missing.length) {
			console.log(`  ${chromeCode}: translating ${missing.length} string(s)…`);
			const results = await translateBatch(
				name,
				missing.map((key) => src[key].message),
			);
			missing.forEach((key, i) => {
				filled[key] = results[i];
			});
		} else {
			console.log(`  ${chromeCode}: up to date`);
		}

		// Rebuild in source order: reuse an existing translation, else the fresh one.
		const out = {};
		for (const [key, entry] of Object.entries(src)) {
			out[key] = { message: existing[key]?.message ?? filled[key] };
			if (entry.description) out[key].description = entry.description;
		}
		mkdirSync(dir, { recursive: true });
		writeFileSync(target, `${JSON.stringify(out, null, "\t")}\n`);
		if (missing.length) console.log(`  ${chromeCode}: wrote ${missing.length}`);
	}
}
