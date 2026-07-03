// Pure filter + sort for the vault list: multi-token substring match, a type
// filter, and name/recency sorts. Kept free of React/UI so it is the test
// surface; VaultHome renders whatever this returns.

import { z } from "zod";
import type { EntryType } from "../../../hooks/useVault";

/** Type filter values; "all" disables the filter. */
export const TYPE_FILTERS = ["all", "login", "card", "note", "ssh-key"] as const;
export type TypeFilter = (typeof TYPE_FILTERS)[number];

export const SORT_KEYS = [
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
}

export const DEFAULT_SEARCH: VaultSearch = { q: "", type: "all", sort: "name-asc" };

/**
 * Route search-param validator. Every field is optional and `.catch`es to
 * undefined, so an unknown/garbage param is dropped (never throws) and the
 * route falls back to DEFAULT_SEARCH. All-optional output also keeps `search`
 * optional for the many `navigate({ to: "/vault" })` call sites.
 */
export const vaultSearchSchema = z.object({
	q: z.string().optional().catch(undefined),
	type: z.enum(TYPE_FILTERS).optional().catch(undefined),
	sort: z.enum(SORT_KEYS).optional().catch(undefined),
});

/** The fields the search reads. A `VaultListItem` satisfies this. */
export interface SearchableEntry {
	name: string;
	type: EntryType;
	/** Pre-lowercased haystack (name, username, urls, custom fields, ...). */
	searchText: string;
	createdAt?: number;
	updatedAt?: number;
	lastUsedAt?: number;
}

/** Split a raw query into lowercased tokens. */
export function queryTokens(q: string): string[] {
	return q.toLowerCase().split(/\s+/).filter(Boolean);
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
 * Filter by type, then require every query token to appear (substring, order-
 * independent), then sort. Pure: the input array is not mutated.
 */
export function filterAndSortEntries<T extends SearchableEntry>(
	items: T[],
	search: VaultSearch,
): T[] {
	const tokens = queryTokens(search.q);
	const filtered = items.filter((item) => {
		if (search.type !== "all" && item.type !== search.type) return false;
		return tokens.every((tok) => item.searchText.includes(tok));
	});
	return filtered.sort(COMPARATORS[search.sort]);
}
