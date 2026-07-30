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
}

export const DEFAULT_SEARCH: VaultSearch = { q: "", type: "all", sort: "name-asc" };

// Route search-param validator. All-optional (`.catch` drops garbage) so bad
// params fall back to DEFAULT_SEARCH and `navigate({ to: "/vault" })` needs no search.
export const vaultSearchSchema = z.object({
	q: z.string().optional().catch(undefined),
	type: z.enum(TYPE_FILTERS).optional().catch(undefined),
	sort: z.enum(SORT_KEYS).optional().catch(undefined),
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

/** Filter by type + all query tokens, then sort; `matchedIds` float to the top. Pure. */
export function filterAndSortEntries<T extends SearchableEntry>(
	items: T[],
	search: VaultSearch,
	matchedIds?: ReadonlySet<string>,
): T[] {
	const tokens = queryTokens(search.q);
	const filtered = items.filter((item) => {
		if (search.type !== "all" && item.type !== search.type) return false;
		return tokens.every((tok) => item.searchText.includes(tok));
	});
	const cmp = COMPARATORS[search.sort];
	if (!matchedIds?.size) return filtered.sort(cmp);
	const rank = (i: SearchableEntry) => (matchedIds.has(i.id) ? 0 : 1);
	return filtered.sort((a, b) => rank(a) - rank(b) || cmp(a, b));
}
