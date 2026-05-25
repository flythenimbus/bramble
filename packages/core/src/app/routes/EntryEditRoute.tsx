import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { usePrefs } from "../../hooks/usePrefs";
import { type EntryData, useVault } from "../../hooks/useVault";
import { checkPasswordBreach } from "../../util/pwned";
import { usePopOut } from "../hooks/usePopOut";
import { CreatePassword, type CreatePasswordDraft } from "../screens/CreatePassword/CreatePassword";

export function EntryEditRoute() {
	const navigate = useNavigate();
	const { entryId } = useParams({ from: "/_app/vault/$entryId/edit" });
	const { entries, updateEntry, ready } = useVault();
	const { prefs } = usePrefs();
	const { registerDraftGetter, takeInitialDraft } = usePopOut();
	const [draft] = useState(() => takeInitialDraft() as CreatePasswordDraft | undefined);
	const entry = entries.find((e) => e.id === entryId);

	// Only bail once the vault has finished hydrating — a detached window can
	// boot straight onto this route before `entries` has loaded, and we don't
	// want to bounce off the restored route in that window.
	useEffect(() => {
		if (ready && !entry) navigate({ to: "/vault" });
	}, [ready, entry, navigate]);

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
				draftValues={draft}
				registerDraft={registerDraftGetter}
				submitLabel="Update password"
				onBack={() => navigate({ to: "/vault/$entryId", params: { entryId } })}
				onSave={handleSave}
			/>
		</div>
	);
}
