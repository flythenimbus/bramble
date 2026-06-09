import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { usePrefs } from "../../hooks/usePrefs";
import { type EntryData, useVault } from "../../hooks/useVault";
import { checkPasswordBreach } from "../../util/pwned";
import { getEntryMode } from "../entry-modes";
import { usePopOut } from "../hooks/usePopOut";
import { EntryForm, type EntryFormDraft } from "../screens/CreateEntry/EntryForm";

/** Edit route for an existing entry; restores pop-out drafts and re-checks breach on password change. */
export function EntryEditRoute() {
	const navigate = useNavigate();
	const { entryId } = useParams({ from: "/_app/vault/$entryId/edit" });
	const { entries, updateEntry } = useVault();
	const { prefs } = usePrefs();
	const { registerDraftGetter, takeInitialDraft } = usePopOut();
	// Pop-out draft takes precedence over the stored entry; consumed once on mount.
	const [draft] = useState(() => takeInitialDraft() as EntryFormDraft | undefined);
	const entry = entries.find((e) => e.id === entryId);

	if (!entry) return null;

	const mode = getEntryMode(entry.type);

	const handleSave = async (data: EntryData) => {
		// Re-check breach only when a login's password changed; reuse the cached value otherwise.
		if (data.type === "login" && entry.type === "login") {
			const passwordChanged = data.password !== entry.password;
			const breach =
				passwordChanged && prefs.breachCheckEnabled
					? await checkPasswordBreach(data.password)
					: entry.breach;
			await updateEntry(entryId, { ...data, breach });
			return;
		}
		await updateEntry(entryId, data);
	};

	return (
		<div className="flex-1 overflow-y-auto">
			<EntryForm
				key={entry.type}
				type={entry.type}
				initialEntry={entry}
				initialBreach={
					prefs.breachCheckEnabled && entry.type === "login" ? entry.breach : undefined
				}
				draftValues={draft}
				registerDraft={registerDraftGetter}
				submitLabel={`Update ${mode.label}`}
				onBack={() => navigate({ to: "/vault/$entryId", params: { entryId } })}
				onSave={handleSave}
			/>
		</div>
	);
}
