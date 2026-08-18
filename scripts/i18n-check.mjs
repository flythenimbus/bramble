#!/usr/bin/env node
// CI / release gate: fail if any locale catalog has missing entries. Pure and
// model-free. Covers every surface: Lingui .po, Android strings.xml, iOS
// .xcstrings, the Chrome extension _locales, the desktop app's native menus, and
// fastlane store metadata (presence + App Store length caps).
//
//   node scripts/i18n-check.mjs            # validate committed catalogs
//   node scripts/i18n-check.mjs --extract  # run `lingui extract` first (CI),
//                                            so newly-added source strings that
//                                            were never translated also fail
//
// Exit 0 = all locales complete; exit 1 = something is missing (with a report).

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	ANDROID_FASTLANE_DIR,
	ANDROID_RES,
	CHROME_LOCALES_DIR,
	FASTLANE_DIR,
	LOCALES,
	PO_CATALOG,
	TAURI_LOCALES_DIR,
	XCSTRINGS,
} from "./i18n/locales.mjs";

const problems = [];
const note = (m) => problems.push(m);

if (process.argv.includes("--extract")) {
	console.log("running lingui extract…");
	execSync("pnpm run i18n:extract", { stdio: "inherit" });
}

// --- Lingui .po: any target locale with an empty msgstr is untranslated ---
const decode = (raw) =>
	raw ? [...raw.matchAll(/"([^]*?)"/g)].map((m) => m[1]).join("") : "";
for (const { code } of LOCALES) {
	const path = PO_CATALOG(code);
	if (!existsSync(path)) {
		note(`po[${code}]: catalog missing (run pnpm i18n:extract)`);
		continue;
	}
	const missing = readFileSync(path, "utf8")
		.split(/\n\n+/)
		.filter((b) => {
			const id = decode(b.match(/^msgid ((?:"[^]*?"\s*)+)/m)?.[1]);
			const str = decode(b.match(/^msgstr ((?:"[^]*?"\s*)+)/m)?.[1]);
			return id && !str;
		}).length;
	if (missing) note(`po[${code}]: ${missing} untranslated string(s)`);
}

// --- Android: every translatable source string present in each values-<locale> ---
const SKIP = new Set(["package_name", "custom_url_scheme", "app_name", "title_activity_main"]);
const androidNames = (xml) =>
	[...xml.matchAll(/<string\s+name="([^"]+)"([^>]*)>/g)]
		.filter(([, name, attrs]) => !SKIP.has(name) && !/translatable\s*=\s*"false"/.test(attrs))
		.map(([, name]) => name);
const androidSrc = join(ANDROID_RES, "values", "strings.xml");
if (existsSync(androidSrc)) {
	const want = androidNames(readFileSync(androidSrc, "utf8"));
	for (const { android } of LOCALES) {
		const path = join(ANDROID_RES, `values-${android}`, "strings.xml");
		const have = existsSync(path)
			? new Set([...readFileSync(path, "utf8").matchAll(/<string\s+name="([^"]+)"/g)].map((m) => m[1]))
			: new Set();
		const miss = want.filter((n) => !have.has(n));
		if (miss.length) note(`android[values-${android}]: ${miss.length} missing (${miss.slice(0, 3).join(", ")}…)`);
	}
}

// --- iOS .xcstrings: every key has a localization for each target locale ---
if (existsSync(XCSTRINGS)) {
	const cat = JSON.parse(readFileSync(XCSTRINGS, "utf8"));
	for (const { code } of LOCALES) {
		const miss = Object.keys(cat.strings ?? {}).filter((k) => !cat.strings[k].localizations?.[code]);
		if (miss.length) note(`xcstrings[${code}]: ${miss.length} key(s) missing`);
	}
}

// --- Chrome extension _locales: every en key present (and non-empty) per locale ---
// getMessage falls back to default_locale, so a gap degrades to English silently rather
// than breaking: only this check catches it. Chrome locale dirs use underscores (pt_BR).
const chromeSrc = join(CHROME_LOCALES_DIR, "en", "messages.json");
if (existsSync(chromeSrc)) {
	const want = Object.keys(JSON.parse(readFileSync(chromeSrc, "utf8")));
	for (const { code } of LOCALES) {
		const chromeCode = code.replace("-", "_");
		const path = join(CHROME_LOCALES_DIR, chromeCode, "messages.json");
		if (!existsSync(path)) {
			note(`chrome-locales[${chromeCode}]: messages.json missing (run pnpm i18n:native)`);
			continue;
		}
		const have = JSON.parse(readFileSync(path, "utf8"));
		const miss = want.filter((k) => !have[k]?.message);
		if (miss.length) {
			note(`chrome-locales[${chromeCode}]: ${miss.length} missing (${miss.slice(0, 3).join(", ")}…)`);
		}
	}
}

// --- Tauri native chrome: every en key present per locale, placeholders intact ---
// The binary falls back to English key by key, so a gap is invisible at runtime: a German menu
// with two English items looks like a translation choice rather than a missing string. The Rust
// tests assert the same thing, this is what fails the release when a locale was never generated.
const tauriSrc = join(TAURI_LOCALES_DIR, "en.json");
if (existsSync(tauriSrc)) {
	const src = JSON.parse(readFileSync(tauriSrc, "utf8"));
	for (const { code } of LOCALES) {
		const path = join(TAURI_LOCALES_DIR, `${code}.json`);
		if (!existsSync(path)) {
			note(`tauri-locales[${code}]: ${code}.json missing (run pnpm i18n:native)`);
			continue;
		}
		const have = JSON.parse(readFileSync(path, "utf8"));
		const miss = Object.keys(src).filter((k) => !have[k]);
		if (miss.length) {
			note(`tauri-locales[${code}]: ${miss.length} missing (${miss.slice(0, 3).join(", ")}…)`);
		}
		// A dropped {app} renders as a menu item with no application name in it.
		const dropped = Object.entries(src).filter(
			([k, v]) =>
				have[k] &&
				["{app}", "{author}"].some((p) => v.includes(p) !== have[k].includes(p)),
		);
		if (dropped.length) {
			note(`tauri-locales[${code}]: placeholder lost in ${dropped.map(([k]) => k).join(", ")}`);
		}
	}
}

// --- fastlane: each store-locale dir has the source files, all within caps ---
const LIMITS = { "keywords.txt": 100, "subtitle.txt": 30, "promotional_text.txt": 170, "name.txt": 30 };
const srcDir = join(FASTLANE_DIR, "en-US");
if (existsSync(srcDir)) {
	const files = readdirSync(srcDir).filter((f) => f.endsWith(".txt"));
	for (const { appStore } of LOCALES) {
		const dir = join(FASTLANE_DIR, appStore);
		for (const f of files) {
			const path = join(dir, f);
			if (!existsSync(path)) {
				note(`fastlane[${appStore}]: missing ${f}`);
				continue;
			}
			const len = readFileSync(path, "utf8").trim().length;
			if (LIMITS[f] && len > LIMITS[f]) note(`fastlane[${appStore}/${f}]: ${len} > ${LIMITS[f]} char cap`);
		}
	}
}

// --- Android fastlane (store listing): each locale has the copy, within caps ---
const ANDROID_STORE_LIMITS = { "title.txt": 30, "short_description.txt": 80, "full_description.txt": 4000 };
for (const { appStore } of [{ appStore: "en-US" }, ...LOCALES]) {
	const dir = join(ANDROID_FASTLANE_DIR, appStore);
	for (const [f, limit] of Object.entries(ANDROID_STORE_LIMITS)) {
		const path = join(dir, f);
		if (!existsSync(path)) {
			note(`android-fastlane[${appStore}]: missing ${f} (run pnpm i18n:native)`);
			continue;
		}
		const len = readFileSync(path, "utf8").trim().length;
		if (len > limit) note(`android-fastlane[${appStore}/${f}]: ${len} > ${limit} char cap`);
	}
}

if (problems.length) {
	console.error(`\n✗ i18n check failed (${problems.length} issue(s)):`);
	for (const p of problems) console.error(`  - ${p}`);
	console.error("\nRun `pnpm i18n` (web) and/or `pnpm i18n:native` (mobile/store) to fill gaps.");
	process.exit(1);
}
console.log(
	"✓ i18n check passed: all locales complete across po, android, xcstrings, chrome _locales, tauri menus, fastlane (iOS + Android)",
);
