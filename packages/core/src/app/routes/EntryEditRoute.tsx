import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { useVault } from "../../hooks/useVault";
import { CreatePassword } from "../screens/CreatePassword/CreatePassword";

export function EntryEditRoute() {
	const navigate = useNavigate();
	const { entryId } = useParams({ from: "/_app/vault/$entryId/edit" });
	const { entries, updateEntry } = useVault();
	const entry = entries.find((e) => e.id === entryId);

	useEffect(() => {
		if (!entry) navigate({ to: "/vault" });
	}, [entry, navigate]);

	if (!entry) return null;

	const { id: _id, ...initialValues } = entry;

	return (
		<div className="flex-1 overflow-y-auto">
			<CreatePassword
				initialValues={initialValues}
				submitLabel="Update password"
				onBack={() => navigate({ to: "/vault/$entryId", params: { entryId } })}
				onSave={(data) => updateEntry(entryId, data)}
			/>
		</div>
	);
}
