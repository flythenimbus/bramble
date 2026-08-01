// Entry -> vault-list row.
//
// Extracted from the route and spread rather than field-by-field on purpose: the previous
// hand-written mapping silently dropped a field a mode had started returning (the passkey
// marker), and nothing failed. Anything a mode's `row()` produces now reaches the list by
// default, and the few fields the list owns are applied over the top.

import type { Entry } from "../../../hooks/useVault";
import { getEntryMode } from "../../entry-modes";
import { customFieldsCopyItems, customFieldsSearchText } from "../../entry-modes/custom-fields";
import type { VaultListItem } from "./VaultHome";

/** `showBreaches` off hides the badge without the list having to know why. */
export function toListItem(entry: Entry, showBreaches: boolean): VaultListItem {
	const mode = getEntryMode(entry.type);
	const view = mode.row(entry);
	return {
		...view,
		id: entry.id,
		type: entry.type,
		name: entry.name,
		leaked: showBreaches ? view.leaked : false,
		// Custom fields are shared across all modes, so they fold into copy actions and search
		// text here rather than in each descriptor.
		copyItems: [...view.copyItems, ...customFieldsCopyItems(entry.customFields)],
		searchText:
			`${mode.searchText(entry)} ${customFieldsSearchText(entry.customFields)}`.toLowerCase(),
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt,
		lastUsedAt: entry.lastUsedAt,
	};
}
