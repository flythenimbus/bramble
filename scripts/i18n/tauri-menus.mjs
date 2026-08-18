// Tauri native-chrome adapter: generates packages/platform-desktop/src-tauri/locales/<code>.json
// from the en source, which the desktop binary embeds with include_str! and resolves from the OS
// locale at startup (see src-tauri/src/i18n.rs). Covers the tray menu and the macOS menu bar,
// neither of which the webview can draw, so neither can use the Lingui catalogs.
//
// Incremental, like the other adapters: only keys missing from a target locale are translated,
// existing translations are kept so a manual edit wins, and the file is rewritten in source-key
// order, dropping keys no longer in en. Run after editing en.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCALES, SOURCE, TAURI_LOCALES_DIR } from "./locales.mjs";
import { translateBatch } from "./ollama.mjs";

// `{app}` and `{author}` are substituted in Rust, so the model must carry them through untouched
// while still being free to move them: German ends with the verb where Spanish needs a preposition.
const PLACEHOLDERS =
	"These are application menu items. Keep any {app} or {author} placeholder exactly as written, " +
	"including the braces, and place it where the target language wants it. Prefer the wording the " +
	"platform itself uses for standard menu commands in this language.";

export async function run() {
	console.log("• Tauri native chrome (tray + macOS menu)");
	const srcPath = join(TAURI_LOCALES_DIR, `${SOURCE}.json`);
	if (!existsSync(srcPath)) {
		console.log(`  no source ${SOURCE}.json — skipping`);
		return;
	}
	const src = JSON.parse(readFileSync(srcPath, "utf8"));
	for (const { code, name } of LOCALES) {
		const target = join(TAURI_LOCALES_DIR, `${code}.json`);
		const existing = existsSync(target) ? JSON.parse(readFileSync(target, "utf8")) : {};

		const missing = Object.keys(src).filter((key) => !existing[key]);
		const filled = {};
		if (missing.length) {
			console.log(`  ${code}: translating ${missing.length} string(s)…`);
			const results = await translateBatch(
				`${name}. ${PLACEHOLDERS}`,
				missing.map((key) => src[key]),
			);
			missing.forEach((key, i) => {
				filled[key] = results[i];
			});
		} else {
			console.log(`  ${code}: up to date`);
		}

		// Rebuild in source order: reuse an existing translation, else the fresh one.
		const out = {};
		for (const key of Object.keys(src)) out[key] = existing[key] ?? filled[key];
		mkdirSync(TAURI_LOCALES_DIR, { recursive: true });
		writeFileSync(target, `${JSON.stringify(out, null, "\t")}\n`);
		if (missing.length) console.log(`  ${code}: wrote ${missing.length}`);
	}
}
