import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { usePrefs } from "../../hooks/usePrefs";
import { useVault } from "../../hooks/useVault";
import { getEntryMode } from "../entry-modes";
import { customFieldsCopyItems, customFieldsSearchText } from "../entry-modes/custom-fields";
import { VaultHome, type VaultListItem } from "../screens/VaultHome/VaultHome";

/** Vault list route: projects entries into rows via their entry-mode descriptors. */
export function VaultHomeRoute() {
	const navigate = useNavigate();
	const { entries, deleteEntry } = useVault();
	const { prefs } = usePrefs();
	// Hide stored breach flags when breach checking is off.
	const showBreaches = prefs.breachCheckEnabled;

	// Project each entry into a list row via its mode descriptor (type-agnostic).
	const items = useMemo<VaultListItem[]>(
		() =>
			entries.map((entry) => {
				const mode = getEntryMode(entry.type);
				const view = mode.row(entry);
				// Custom fields are shared across all modes, so the row folds them
				// into copy actions and search text here rather than in each
				// descriptor's row()/searchText().
				return {
					id: entry.id,
					type: entry.type,
					name: entry.name,
					icon: view.icon,
					initials: view.initials,
					secondary: view.secondary,
					leaked: showBreaches ? view.leaked : false,
					copyItems: [...view.copyItems, ...customFieldsCopyItems(entry.customFields)],
					searchText:
						`${mode.searchText(entry)} ${customFieldsSearchText(entry.customFields)}`.toLowerCase(),
				};
			}),
		[entries, showBreaches],
	);

	return (
		<VaultHome
			items={items}
			onCreate={(type) => navigate({ to: "/vault/new/$type", params: { type } })}
			onSelectEntry={(entryId) => navigate({ to: "/vault/$entryId", params: { entryId } })}
			onEditEntry={(entryId) => navigate({ to: "/vault/$entryId/edit", params: { entryId } })}
			onDeleteEntry={deleteEntry}
		/>
	);
}
