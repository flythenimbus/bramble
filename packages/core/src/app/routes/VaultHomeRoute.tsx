import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useVault } from "../../hooks/useVault";
import { VaultHome } from "../screens/VaultHome/VaultHome";

export function VaultHomeRoute() {
	const navigate = useNavigate();
	const { isLocked, entries, deleteEntry } = useVault();

	// Kick back to auth if we ended up here while locked.
	useEffect(() => {
		if (isLocked) navigate({ to: "/" });
	}, [isLocked, navigate]);

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
