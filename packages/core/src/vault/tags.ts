// Every rule about tags, in one place: what a tag may be, how two are compared, and
// what the vault's tag vocabulary is. Tags reach the entry form, the search box, the
// bulk actions, four importers and the KDBX mapper, so the alternative is six slightly
// different opinions on whether "Work" and "work" are the same tag.

import type { Entry } from "../hooks/useVault";

/** Longest a single tag may be. Long enough for "shared household accounts". */
export const MAX_TAG_LENGTH = 64;
/** Most tags one entry may carry. A cap, not a target; a vault is not a tagging system. */
export const MAX_TAGS_PER_ENTRY = 32;

/**
 * The comparison key for a tag. Tags display exactly as typed but match
 * case-insensitively, so "Work" and "work" are one tag, as in 1Password. Locale-aware
 * lowercasing, so Turkish "I" folds the way a Turkish speaker expects.
 */
export function tagKey(tag: string): string {
	return tag.trim().toLocaleLowerCase();
}

/**
 * Clean a set of tags for storage: trim, drop a leading `#` (the search syntax, not part
 * of the name), hyphenate inner whitespace, drop empties, truncate over-long ones, and
 * dedupe by `tagKey` keeping the first spelling the user typed. Returns `undefined` for
 * an empty result, so an entry with no tags carries no key at all — the same convention
 * `formToCustomFields` uses.
 *
 * Whitespace becomes `-` rather than being preserved because the search syntax is
 * whitespace-delimited: a tag literally named "shared household" could never be typed as
 * `#shared household`, which would parse as the tag `shared` plus the word `household`.
 * Hyphenating makes every stored tag reachable by the syntax that exists, and the change
 * is visible on the chip the moment it is committed rather than being a silent mismatch
 * only discovered later at the search box.
 *
 * Accepts `unknown` because it is also the gate for tags arriving from an import file or
 * a foreign vault, where the shape is whatever the source felt like emitting.
 */
export function normalizeTags(raw: unknown): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: string[] = [];
	const seen = new Set<string>();
	for (const candidate of raw) {
		if (typeof candidate !== "string") continue;
		const tag = candidate
			.trim()
			.replace(/^#+/, "")
			.replace(/\s+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, MAX_TAG_LENGTH);
		if (!tag) continue;
		const key = tagKey(tag);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(tag);
		if (out.length >= MAX_TAGS_PER_ENTRY) break;
	}
	return out.length > 0 ? out : undefined;
}

/** Whether two normalized tag lists hold the same tags in the same order. */
export function tagsEqual(a: string[] | undefined, b: string[] | undefined): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	return a.every((tag, i) => tag === b[i]);
}

/** True if `entry` carries a tag whose key is exactly `key`. */
export function hasTagKey(entry: { tags?: string[] }, key: string): boolean {
	return (entry.tags ?? []).some((t) => tagKey(t) === key);
}

/**
 * The vault's tag vocabulary: every distinct tag, sorted for display. Feeds the search
 * box's `#` suggestions and the tag editor's, so both offer the same list and neither
 * invents a second spelling of a tag that already exists.
 *
 * Deduped by key, first spelling seen winning, so a vault holding both "Work" and "work"
 * offers one suggestion rather than two that behave identically. First-seen rather than
 * some tie-break on the spellings themselves: `normalizeTags` already resolves a
 * collision that way, and two rules for the same question is one too many.
 */
export function allTags(entries: readonly Entry[]): string[] {
	const byKey = new Map<string, string>();
	for (const entry of entries) {
		for (const tag of entry.tags ?? []) {
			const key = tagKey(tag);
			if (key && !byKey.has(key)) byKey.set(key, tag);
		}
	}
	return [...byKey.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}
