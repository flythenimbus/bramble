import { Trans } from "@lingui/react/macro";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePlatform } from "../../context/PlatformContext";
import { usePrefs } from "../../hooks/usePrefs";
import { isLogin, useVault } from "../../hooks/useVault";
import { allTags } from "../../vault/tags";
import { ReviewNudgeCard } from "../components/ReviewNudgeCard";
import { useReviewNudge } from "../hooks/useReviewNudge";
import { toListItem } from "../screens/VaultHome/list-item";
import { VaultHome, type VaultListItem } from "../screens/VaultHome/VaultHome";
import { DEFAULT_SEARCH, type VaultSearch } from "../screens/VaultHome/vault-search";

/** Vault list route: projects entries into rows via their entry-mode descriptors. */
export function VaultHomeRoute() {
	const navigate = useNavigate();
	// Per-field `??` (not spread): a `.catch`ed param can be present-but-undefined.
	const raw = useSearch({ from: "/_app/vault" });
	const search = useMemo<VaultSearch>(
		() => ({
			q: raw.q ?? DEFAULT_SEARCH.q,
			type: raw.type ?? DEFAULT_SEARCH.type,
			sort: raw.sort ?? DEFAULT_SEARCH.sort,
			archived: raw.archived ?? DEFAULT_SEARCH.archived,
		}),
		[raw.q, raw.type, raw.sort, raw.archived],
	);
	const { entries, ready, deleteEntry, touchEntry } = useVault();
	const { shell } = usePlatform();
	const { prefs, update } = usePrefs();
	// Hide stored breach flags when breach checking is off.
	const showBreaches = prefs.breachCheckEnabled;

	// Logins matching the current tab, floated to the top (extension only; else []).
	const [matchedIds, setMatchedIds] = useState<ReadonlySet<string>>(() => new Set());
	useEffect(() => {
		let cancelled = false;
		// Archived logins are excluded: the tab match tints and floats a row as the
		// credential for this site, which is exactly the claim archiving withdraws.
		const logins = entries
			.filter(isLogin)
			.filter((e) => e.archivedAt === undefined)
			.map((e) => ({ id: e.id, urls: e.urls, subdomainMatch: e.subdomainMatch }));
		if (logins.length === 0) {
			setMatchedIds((prev) => (prev.size === 0 ? prev : new Set()));
			return;
		}
		shell
			.matchCurrentTab(logins)
			.then((ids) => {
				if (!cancelled)
					setMatchedIds((prev) =>
						prev.size === ids.length && ids.every((id) => prev.has(id)) ? prev : new Set(ids),
					);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [shell, entries]);

	// The store-review ask. Called unconditionally (it counts sessions whether or not it ever
	// asks) and usually null. Entries are the whole vault, archived included: an archived entry
	// is still one this person put there, which is all the signal is measuring.
	const reviewNudge = useReviewNudge(entries.length);

	// The vault's tag vocabulary, for the search bar's `#` suggestions. Taken from ALL
	// entries, archived included: an archived entry is still tagged, and the archive view
	// shares the same search box.
	const tags = useMemo(() => allTags(entries), [entries]);

	// Project each entry into a list row via its mode descriptor (type-agnostic).
	const items = useMemo<VaultListItem[]>(
		() => entries.map((entry) => toListItem(entry, showBreaches)),
		[entries, showBreaches],
	);

	// replace: typing shouldn't stack history entries.
	const onSearchChange = (patch: Partial<VaultSearch>) =>
		navigate({ to: "/vault", search: (prev) => ({ ...prev, ...patch }), replace: true });

	const onSelectEntry = useCallback(
		(entryId: string) => navigate({ to: "/vault/$entryId", params: { entryId } }),
		[navigate],
	);
	const onEditEntry = useCallback(
		(entryId: string) => navigate({ to: "/vault/$entryId/edit", params: { entryId } }),
		[navigate],
	);
	const onUseEntry = useCallback((entryId: string) => void touchEntry(entryId), [touchEntry]);

	// Until the vault has finished decrypting, `entries` is []; showing VaultHome
	// here would flash "Your vault is empty" on a large vault. Show a loader instead.
	if (!ready) {
		return (
			<main className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
				<Loader2 className="w-6 h-6 animate-spin" />
				<p className="text-sm">
					<Trans>Opening…</Trans>
				</p>
			</main>
		);
	}

	return (
		<VaultHome
			items={items}
			search={search}
			onSearchChange={onSearchChange}
			matchedIds={matchedIds}
			onCreate={(type) => navigate({ to: "/vault/new/$type", params: { type } })}
			onSelectEntry={onSelectEntry}
			onEditEntry={onEditEntry}
			onDeleteEntry={deleteEntry}
			entries={entries}
			onUseEntry={onUseEntry}
			tags={tags}
			statsCollapsed={prefs.statsCollapsed}
			onToggleStats={() => void update("statsCollapsed", !prefs.statsCollapsed)}
			reviewNudge={reviewNudge ? <ReviewNudgeCard nudge={reviewNudge} /> : undefined}
		/>
	);
}
