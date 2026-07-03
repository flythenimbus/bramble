import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { usePlatform } from "../../context/PlatformContext";
import { usePrefs } from "../../hooks/usePrefs";
import { isLogin, useVault } from "../../hooks/useVault";
import { getEntryMode } from "../entry-modes";
import { customFieldsCopyItems, customFieldsSearchText } from "../entry-modes/custom-fields";
import { VaultHome, type VaultListItem } from "../screens/VaultHome/VaultHome";
import { DEFAULT_SEARCH, type VaultSearch } from "../screens/VaultHome/vault-search";

/** Vault list route: projects entries into rows via their entry-mode descriptors. */
export function VaultHomeRoute() {
	const navigate = useNavigate();
	// Per-field `??` (not spread): a `.catch`ed param can be present-but-undefined.
	const raw = useSearch({ from: "/_app/vault" });
	const search: VaultSearch = {
		q: raw.q ?? DEFAULT_SEARCH.q,
		type: raw.type ?? DEFAULT_SEARCH.type,
		sort: raw.sort ?? DEFAULT_SEARCH.sort,
	};
	const { entries, deleteEntry, touchEntry } = useVault();
	const { shell } = usePlatform();
	const { prefs } = usePrefs();
	// Hide stored breach flags when breach checking is off.
	const showBreaches = prefs.breachCheckEnabled;

	// Logins matching the current tab, floated to the top (extension only; else []).
	const [matchedIds, setMatchedIds] = useState<ReadonlySet<string>>(() => new Set());
	useEffect(() => {
		let cancelled = false;
		const logins = entries
			.filter(isLogin)
			.map((e) => ({ id: e.id, urls: e.urls, subdomainMatch: e.subdomainMatch }));
		if (logins.length === 0) {
			setMatchedIds(new Set());
			return;
		}
		shell
			.matchCurrentTab(logins)
			.then((ids) => {
				if (!cancelled) setMatchedIds(new Set(ids));
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [shell, entries]);

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
					createdAt: entry.createdAt,
					updatedAt: entry.updatedAt,
					lastUsedAt: entry.lastUsedAt,
				};
			}),
		[entries, showBreaches],
	);

	// replace: typing shouldn't stack history entries.
	const onSearchChange = (patch: Partial<VaultSearch>) =>
		navigate({ to: "/vault", search: (prev) => ({ ...prev, ...patch }), replace: true });

	return (
		<VaultHome
			items={items}
			search={search}
			onSearchChange={onSearchChange}
			matchedIds={matchedIds}
			onCreate={(type) => navigate({ to: "/vault/new/$type", params: { type } })}
			onSelectEntry={(entryId) => navigate({ to: "/vault/$entryId", params: { entryId } })}
			onEditEntry={(entryId) => navigate({ to: "/vault/$entryId/edit", params: { entryId } })}
			onDeleteEntry={deleteEntry}
			onUseEntry={(entryId) => void touchEntry(entryId)}
		/>
	);
}
