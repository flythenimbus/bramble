// Pure set algebra for the vault list's bulk selection; the test surface behind
// VaultHome's selection state. Every function returns the SAME set reference when
// nothing changed, so a no-op never re-renders the list.

/** The fields selection reads. A `VaultListItem` satisfies this. */
export interface SelectableEntry {
	id: string;
}

export type Selection = ReadonlySet<string>;

export const EMPTY_SELECTION: Selection = new Set<string>();

/** Add the id if absent, remove it if present. */
export function toggleSelected(selected: Selection, id: string): Selection {
	const next = new Set(selected);
	if (!next.delete(id)) next.add(id);
	return next;
}

/** Select every id in `items` on top of the current selection. */
export function selectAll(selected: Selection, items: readonly SelectableEntry[]): Selection {
	if (items.every((item) => selected.has(item.id))) return selected;
	const next = new Set(selected);
	for (const item of items) next.add(item.id);
	return next;
}

/** True once every one of `items` is selected (false for an empty list: nothing to act on). */
export function allSelected(selected: Selection, items: readonly SelectableEntry[]): boolean {
	return items.length > 0 && items.every((item) => selected.has(item.id));
}

/**
 * Drop ids that no longer exist. Selection deliberately survives a filter change
 * (you can search, select, search again, then act on the union), so the only thing
 * that may silently leave it is an entry that is actually gone: deleted here, or
 * removed by a sync merge while the list was open.
 */
export function pruneSelection(selected: Selection, items: readonly SelectableEntry[]): Selection {
	if (selected.size === 0) return selected;
	const live = new Set(items.map((item) => item.id));
	const next = new Set([...selected].filter((id) => live.has(id)));
	return next.size === selected.size ? selected : next;
}

/**
 * How many selected entries the current filter is hiding. Bulk actions run on the
 * whole selection, so the list has to say when part of it is off-screen.
 */
export function hiddenSelectedCount(
	selected: Selection,
	visible: readonly SelectableEntry[],
): number {
	if (selected.size === 0) return 0;
	const shown = new Set(visible.map((item) => item.id));
	return [...selected].filter((id) => !shown.has(id)).length;
}
