import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { usePrefs } from "../../hooks/usePrefs";
import { useVault } from "../../hooks/useVault";
import { checkPasswordBreach } from "../../util/pwned";
import { EntryDetail } from "../screens/EntryDetail/EntryDetail";

const BREACH_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Route for a single entry's detail view; lazily refreshes login breach status. */
export function EntryDetailRoute() {
	const navigate = useNavigate();
	const { entryId } = useParams({ from: "/_app/vault/$entryId" });
	const { entries, updateEntry, deleteEntry, setEntriesArchived, touchEntry } = useVault();
	const { prefs, loaded: prefsLoaded } = usePrefs();
	const entry = entries.find((e) => e.id === entryId);
	const refreshAttemptedRef = useRef<string | null>(null);

	// Lazily refresh stale/missing breach status, once per entry per mount.
	// refreshAttemptedRef stops the updateEntry write-back from re-triggering the effect.
	useEffect(() => {
		// Breach status is login-only.
		if (entry?.type !== "login" || !prefsLoaded) return;
		if (!prefs.breachCheckEnabled) return;
		if (refreshAttemptedRef.current === entry.id) return;
		const stale = !entry.breach || Date.now() - entry.breach.checkedAt > BREACH_STALE_MS;
		if (!stale) return;
		refreshAttemptedRef.current = entry.id;
		void (async () => {
			const breach = await checkPasswordBreach(entry.password);
			if (!breach) return;
			const { id: _id, ...rest } = entry;
			await updateEntry(entry.id, { ...rest, breach });
		})();
	}, [entry, prefsLoaded, prefs.breachCheckEnabled, updateEntry]);

	if (!entry) return null;

	// Hide a stored breach result while breach checking is off.
	const viewEntry =
		prefs.breachCheckEnabled || entry.type !== "login" ? entry : { ...entry, breach: undefined };

	return (
		<div className="flex-1 overflow-y-auto">
			<EntryDetail
				entry={viewEntry}
				onEdit={() => navigate({ to: "/vault/$entryId/edit", params: { entryId } })}
				onDelete={async () => {
					await deleteEntry(entryId);
					navigate({ to: "/vault" });
				}}
				onSetArchived={(archived) => setEntriesArchived([entryId], archived)}
				// The tag filter lives in `q`, so picking a tag is just a search: one source of
				// truth, and the resulting URL is the same one typing `#tag` would produce.
				onSelectTag={(tag) => navigate({ to: "/vault", search: { q: `#${tag}` } })}
				onUse={() => void touchEntry(entryId)}
			/>
		</div>
	);
}
