// Staleness tracking for the WHOLE-FILE fastlane adapters (iOS + Android store metadata).
//
// The keyed adapters (.po, .xcstrings, _locales, strings.xml) get this for free: the source
// text IS the key, so editing English produces an untranslated entry the next run picks up.
// A whole-file adapter has no such signal - the target either exists or it doesn't - so it
// used to skip anything already present. That silently pinned every locale to whatever
// English said at first generation: an edited description or release note translated
// nowhere, and i18n:check stayed green because it only verifies presence + length.
//
// So record the hash of the English source each translation was generated from, and
// re-translate when that hash moves. A target with NO record is adopted (its hash written,
// the file left alone), so introducing this never overwrites existing copy - only the next
// English edit does.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { repo } from "./locales.mjs";

const MANIFEST = repo("scripts/i18n/translation-sources.json");

const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : {};
let dirty = false;

const key = (targetPath) => relative(repo("."), targetPath);
const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/**
 * Should `targetPath` be regenerated from `sourceText`? True only when we translated it
 * before from DIFFERENT English. An unrecorded target is adopted as current.
 */
export function sourceChanged(targetPath, sourceText) {
	const k = key(targetPath);
	const now = hash(sourceText);
	const prev = manifest[k];
	if (prev === undefined) {
		manifest[k] = now;
		dirty = true;
		return false;
	}
	return prev !== now;
}

/** Record the English a freshly written translation came from. */
export function recordSource(targetPath, sourceText) {
	const k = key(targetPath);
	const now = hash(sourceText);
	if (manifest[k] !== now) {
		manifest[k] = now;
		dirty = true;
	}
}

/** Persist the manifest (no-op when nothing moved). Call at the end of an adapter run. */
export function flushSources() {
	if (!dirty) return;
	const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
	writeFileSync(MANIFEST, `${JSON.stringify(sorted, null, "\t")}\n`);
	dirty = false;
}
