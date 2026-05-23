import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { usePrefs } from "../../hooks/usePrefs";
import { type EntryData, useVault } from "../../hooks/useVault";
import { checkPasswordBreach } from "../../util/pwned";
import { CreatePassword } from "../screens/CreatePassword/CreatePassword";

export function EntryEditRoute() {
	const navigate = useNavigate();
	const { entryId } = useParams({ from: "/_app/vault/$entryId/edit" });
	const { entries, updateEntry } = useVault();
	const { prefs } = usePrefs();
	const entry = entries.find((e) => e.id === entryId);

	useEffect(() => {
		if (!entry) navigate({ to: "/vault" });
	}, [entry, navigate]);

	if (!entry) return null;

	const { id: _id, ...initialValues } = entry;

	const handleSave = async (data: EntryData) => {
		// Re-check breach status when the password actually changed; otherwise
		// keep the previously-cached value so we don't hit the API on every
		// metadata edit.
		const passwordChanged = data.password !== entry.password;
		const breach =
			passwordChanged && prefs.breachCheckEnabled
				? await checkPasswordBreach(data.password)
				: entry.breach;
		await updateEntry(entryId, { ...data, breach });
	};

	return (
		<div className="flex-1 overflow-y-auto">
			<CreatePassword
				initialValues={initialValues}
				initialBreach={entry.breach}
				submitLabel="Update password"
				onBack={() => navigate({ to: "/vault/$entryId", params: { entryId } })}
				onSave={handleSave}
			/>
		</div>
	);
}
