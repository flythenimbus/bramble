import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useVault } from "../../hooks/useVault";
import { VaultHome } from "../screens/VaultHome/VaultHome";

export function VaultHomeRoute() {
	const navigate = useNavigate();
	const { entries, deleteEntry } = useVault();
	// The locked-state redirect to /auth lives in AppLayout, which covers every
	// authed route — no per-route guard needed here.

	const summaries = useMemo(
		() =>
			entries.map((e) => ({
				id: e.id,
				name: e.name,
				url: e.url,
				username: e.username,
				password: e.password,
				leaked: e.breach?.leaked === true,
			})),
		[entries],
	);

	return (
		<VaultHome
			entries={summaries}
			onCreateNew={() => navigate({ to: "/vault/new" })}
			onSelectEntry={(entryId) => navigate({ to: "/vault/$entryId", params: { entryId } })}
			onEditEntry={(entryId) => navigate({ to: "/vault/$entryId/edit", params: { entryId } })}
			onDeleteEntry={deleteEntry}
		/>
	);
}
