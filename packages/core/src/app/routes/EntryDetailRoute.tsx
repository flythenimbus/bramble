import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { useVault } from "../../hooks/useVault";
import { EntryDetail } from "../screens/EntryDetail/EntryDetail";

export function EntryDetailRoute() {
	const navigate = useNavigate();
	const { entryId } = useParams({ from: "/_app/vault/$entryId" });
	const { entries, deleteEntry } = useVault();
	const entry = entries.find((e) => e.id === entryId);

	// If the entry vanished (deleted in another tab, or stale id), kick back.
	useEffect(() => {
		if (!entry) navigate({ to: "/vault" });
	}, [entry, navigate]);

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
