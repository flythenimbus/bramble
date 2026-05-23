import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useVault } from "../../hooks/useVault";
import { VaultHome } from "../screens/VaultHome/VaultHome";

export function VaultHomeRoute() {
	const navigate = useNavigate();
	const { isLocked, entries, deleteEntry } = useVault();

	// Kick back to auth if we ended up here while locked.
	useEffect(() => {
		if (isLocked) navigate({ to: "/" });
	}, [isLocked, navigate]);

	return (
		<VaultHome
			entries={entries}
			onCreateNew={() => navigate({ to: "/vault/new" })}
			onSelectEntry={(entryId) => navigate({ to: "/vault/$entryId", params: { entryId } })}
			onEditEntry={(entryId) => navigate({ to: "/vault/$entryId/edit", params: { entryId } })}
			onDeleteEntry={deleteEntry}
		/>
	);
}
