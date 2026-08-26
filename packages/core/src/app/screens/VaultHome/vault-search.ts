// Pure filter + sort for the vault list; the test surface behind VaultHome.

import { z } from "zod";
import type { EntryType } from "../../../hooks/useVault";

/** Type filter values; "all" disables the filter. */
const TYPE_FILTERS = ["all", "login", "card", "note", "ssh-key"] as const;
export type TypeFilter = (typeof TYPE_FILTERS)[number];

const SORT_KEYS = [
	"name-asc",
	"name-desc",
	"recent-used",
	"recent-added",
	"recent-updated",
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

/** The search/filter/sort state, mirrored in the route's search params. */
export interface VaultSearch {
	q: string;
	type: TypeFilter;
	sort: SortKey;
	/**
	 * Which side of the archive to list. The two sets are disjoint, not additive: false
	 * (the default) lists live entries only, true lists archived ones only. A view rather
	 * than an include-flag, so an archived entry can't be mistaken for a live one in a
	 * list the user searches and fills from.
	 */
	archived: boolean;
}

export const DEFAULT_SEARCH: VaultSearch = {
	q: "",
	type: "all",
	sort: "name-asc",
	archived: false,
};

// Route search-param validator. All-optional (`.catch` drops garbage) so bad
// params fall back to DEFAULT_SEARCH and `navigate({ to: "/vault" })` needs no search.
export const vaultSearchSchema = z.object({
	q: z.string().optional().catch(undefined),
	type: z.enum(TYPE_FILTERS).optional().catch(undefined),
	sort: z.enum(SORT_KEYS).optional().catch(undefined),
	archived: z.boolean().optional().catch(undefined),
});

/** The fields the search reads. A `VaultListItem` satisfies this. */
export interface SearchableEntry {
	id: string;
	name: string;
	type: EntryType;
	/** Pre-lowercased haystack (name, username, urls, custom fields, ...). */
	searchText: string;
	createdAt?: number;
	updatedAt?: number;
	lastUsedAt?: number;
	archived?: boolean;
	/** Lowercased tag keys, so the filter never re-derives them per keystroke. */
	tagKeys?: string[];
}

/** Split a raw query into lowercased tokens. */
export function queryTokens(q: string): string[] {
	return q.toLowerCase().split(/\s+/).filter(Boolean);
}

/** A query split into its free-text tokens and its `#tag` filters (both lowercased). */
export interface ParsedQuery {
	text: string[];
	tags: string[];
}

/**
 * Split a query into free text and `#tag` filters. A bare `#` is not a filter (the user
 * is mid-word), so it is dropped rather than matching every tag.
 */
export function parseQuery(q: string): ParsedQuery {
	const text: string[] = [];
	const tags: string[] = [];
	for (const token of queryTokens(q)) {
		if (!token.startsWith("#")) {
			text.push(token);
			continue;
		}
		const tag = token.replace(/^#+/, "");
		if (tag) tags.push(tag);
	}
	return { text, tags };
}

function byName(a: SearchableEntry, b: SearchableEntry): number {
	return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

// Missing timestamps sort last; ties fall back to name A->Z for a stable order.
function byRecent(key: "lastUsedAt" | "createdAt" | "updatedAt") {
	return (a: SearchableEntry, b: SearchableEntry): number => {
		const av = a[key] ?? Number.NEGATIVE_INFINITY;
		const bv = b[key] ?? Number.NEGATIVE_INFINITY;
		if (av !== bv) return bv - av;
		return byName(a, b);
	};
}

const COMPARATORS: Record<SortKey, (a: SearchableEntry, b: SearchableEntry) => number> = {
	"name-asc": byName,
	"name-desc": (a, b) => byName(b, a),
	"recent-used": byRecent("lastUsedAt"),
	"recent-added": byRecent("createdAt"),
	"recent-updated": byRecent("updatedAt"),
};

/**
 * The `#`-prefixed token the caret is sitting in, lowercased and without its `#`, or null
 * when the query does not end in one. Drives the search bar's tag suggestions: only the
 * LAST token counts, because that is the one still being typed.
 */
export function trailingTagFragment(q: string): string | null {
	if (/\s$/.test(q)) return null;
	const last = q.split(/\s+/).at(-1) ?? "";
	if (!last.startsWith("#")) return null;
	return last.replace(/^#+/, "").toLowerCase();
}

/**
 * Replace the trailing `#fragment` with `#tag` and leave a trailing space, so picking a
 * suggestion lands the user ready to type the next term rather than inside the one they
 * just completed.
 */
export function completeTagFragment(q: string, tag: string): string {
	// Split KEEPING the separators, so the rest of the query survives verbatim rather
	// than being re-joined with whitespace the user didn't type.
	const parts = q.split(/(\s+)/);
	let last = -1;
	for (let i = parts.length - 1; i >= 0; i--) {
		if ((parts[i] ?? "").trim().length > 0) {
			last = i;
			break;
		}
	}
	if (last === -1) return `#${tag} `;
	parts[last] = `#${tag}`;
	return `${parts.join("")} `;
}

/**
 * Filter by archive side + type + every query token, then sort; `matchedIds` float to
 * the top. Pure.
 *
 * `#tag` tokens filter on tags and nothing else, so `#work github` means "tagged work
 * AND matching github" rather than searching for the literal text "#work". Tag matching
 * is by PREFIX: `#wo` matches `work` while the user is still typing, the way the text
 * side already matches on substring, and the search bar's suggestions make the exact
 * form one tap away.
 */
export function filterAndSortEntries<T extends SearchableEntry>(
	items: T[],
	search: VaultSearch,
	matchedIds?: ReadonlySet<string>,
): T[] {
	const { text, tags } = parseQuery(search.q);
	const filtered = items.filter((item) => {
		// The archive side is a hard gate, ahead of the query: searching the live vault must
		// never surface an archived entry, however well it matches.
		if ((item.archived ?? false) !== search.archived) return false;
		if (search.type !== "all" && item.type !== search.type) return false;
		// Every tag token must match some tag, as with text tokens: two of them narrow.
		const keys = item.tagKeys;
		if (tags.length > 0 && !tags.every((t) => keys?.some((k) => k.startsWith(t)))) return false;
		return text.every((tok) => item.searchText.includes(tok));
	});
	const cmp = COMPARATORS[search.sort];
	if (!matchedIds?.size) return filtered.sort(cmp);
	const rank = (i: SearchableEntry) => (matchedIds.has(i.id) ? 0 : 1);
	return filtered.sort((a, b) => rank(a) - rank(b) || cmp(a, b));
}
