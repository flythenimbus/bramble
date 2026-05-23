import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { usePrefs } from "../../hooks/usePrefs";
import { useVault } from "../../hooks/useVault";
import { checkPasswordBreach } from "../../util/pwned";
import { EntryDetail } from "../screens/EntryDetail/EntryDetail";

const BREACH_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function EntryDetailRoute() {
	const navigate = useNavigate();
	const { entryId } = useParams({ from: "/_app/vault/$entryId" });
	const { entries, updateEntry, deleteEntry } = useVault();
	const { prefs, loaded: prefsLoaded } = usePrefs();
	const entry = entries.find((e) => e.id === entryId);
	const refreshAttemptedRef = useRef<string | null>(null);

	// If the entry vanished (deleted in another tab, or stale id), kick back.
	useEffect(() => {
		if (!entry) navigate({ to: "/vault" });
	}, [entry, navigate]);

	useEffect(() => {
		if (!entry || !prefsLoaded) return;
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

	return (
		<div className="flex-1 overflow-y-auto">
			<EntryDetail
				entry={entry}
				onBack={() => navigate({ to: "/vault" })}
				onEdit={() => navigate({ to: "/vault/$entryId/edit", params: { entryId } })}
				onDelete={async () => {
					await deleteEntry(entryId);
					navigate({ to: "/vault" });
				}}
			/>
		</div>
	);
}
