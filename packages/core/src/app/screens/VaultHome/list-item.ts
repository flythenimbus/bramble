// Entry -> vault-list row.
//
// Extracted from the route and spread rather than field-by-field on purpose: the previous
// hand-written mapping silently dropped a field a mode had started returning (the passkey
// marker), and nothing failed. Anything a mode's `row()` produces now reaches the list by
// default, and the few fields the list owns are applied over the top.

import type { Entry } from "../../../hooks/useVault";
import type { EntryConflict } from "../../../sync";
import { tagKey } from "../../../vault/tags";
import { getEntryMode } from "../../entry-modes";
import { customFieldsCopyItems, customFieldsSearchText } from "../../entry-modes/custom-fields";
import type { VaultListItem } from "./VaultHome";

/** `showBreaches` off hides the badge without the list having to know why. */
export function toListItem(
	entry: Entry,
	showBreaches: boolean,
	conflict?: EntryConflict,
	hasFiles = false,
	reused = false,
): VaultListItem {
	const mode = getEntryMode(entry.type);
	const view = mode.row(entry);
	// Ranked in this order while searching (vault-search.ts). Tags join the free text as well as
	// driving the `#tag` filter, so a plain "work" finds the entries tagged work.
	const searchTiers = [
		entry.name,
		`${mode.searchText(entry)} ${(entry.tags ?? []).join(" ")}`,
		`${entry.notes ?? ""} ${customFieldsSearchText(entry.customFields)}`,
	].map((tier) => tier.toLowerCase());
	return {
		...view,
		id: entry.id,
		type: entry.type,
		name: entry.name,
		leaked: showBreaches ? view.leaked : false,
		reused,
		// Custom fields are shared across all modes, so they fold into copy actions and search
		// text here rather than in each descriptor.
		copyItems: [...view.copyItems, ...customFieldsCopyItems(entry.customFields)],
		searchText: searchTiers.join(" "),
		searchTiers,
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt,
		lastUsedAt: entry.lastUsedAt,
		archived: entry.archivedAt !== undefined,
		conflict: conflict !== undefined,
		tagKeys: entry.tags?.map(tagKey),
		hasFiles,
	};
}
