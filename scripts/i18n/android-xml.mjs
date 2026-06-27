// Android string-resource adapter: translates res/values/strings.xml into
// res/values-<qualifier>/strings.xml. Android selects the right file at runtime.
// Skips identifiers/brand and anything marked translatable="false". Idempotent:
// names already present in a target file are left alone.
//
// NOTE: most native UI strings are still hardcoded in Kotlin. Extract them into
// values/strings.xml (and reference via getString) for this to cover them.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ANDROID_RES, LOCALES } from "./locales.mjs";
import { translateBatch } from "./ollama.mjs";

// Identifiers / brand that must never be translated, regardless of attributes.
const SKIP_NAMES = new Set(["package_name", "custom_url_scheme", "app_name", "title_activity_main"]);

// Parse <string name="..">value</string> entries (skips translatable="false").
function parseStrings(xml) {
	const re = /<string\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/string>/g;
	const out = [];
	for (const m of xml.matchAll(re)) {
		const [, name, attrs, raw] = m;
		if (/translatable\s*=\s*"false"/.test(attrs)) continue;
		if (SKIP_NAMES.has(name)) continue;
		out.push({ name, value: unescapeXml(raw) });
	}
	return out;
}

const unescapeXml = (s) =>
	s
		.replace(/\\'/g, "'")
		.replace(/\\"/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");

const escapeXml = (s) =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/'/g, "\\'");

const existingNames = (xml) => new Set([...xml.matchAll(/<string\s+name="([^"]+)"/g)].map((m) => m[1]));

export async function run() {
	console.log("• Android strings.xml");
	const srcPath = join(ANDROID_RES, "values", "strings.xml");
	if (!existsSync(srcPath)) {
		console.log("  no values/strings.xml — skipping");
		return;
	}
	const entries = parseStrings(readFileSync(srcPath, "utf8"));
	if (!entries.length) {
		console.log("  no translatable strings yet (extract Kotlin strings first)");
		return;
	}
	for (const { code, name, android } of LOCALES) {
		const dir = join(ANDROID_RES, `values-${android}`);
		const targetPath = join(dir, "strings.xml");
		const have = existsSync(targetPath) ? existingNames(readFileSync(targetPath, "utf8")) : new Set();
		const todo = entries.filter((e) => !have.has(e.name));
		if (!todo.length) {
			console.log(`  values-${android}: up to date`);
			continue;
		}
		console.log(`  values-${android}: translating ${todo.length}…`);
		const translated = await translateBatch(
			name,
			todo.map((e) => e.value),
		);
		// Rebuild the file from the full entry set so order stays stable.
		const byName = new Map(todo.map((e, i) => [e.name, translated[i]]));
		const lines = entries
			.map((e) => {
				const v = byName.get(e.name) ?? e.value; // keep prior translation if present
				return `    <string name="${e.name}">${escapeXml(v)}</string>`;
			})
			.join("\n");
		mkdirSync(dir, { recursive: true });
		writeFileSync(targetPath, `<?xml version='1.0' encoding='utf-8'?>\n<resources>\n${lines}\n</resources>\n`);
		console.log(`  values-${android}: wrote ${todo.length}`);
	}
}
