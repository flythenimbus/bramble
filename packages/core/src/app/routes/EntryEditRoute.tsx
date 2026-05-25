import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { usePrefs } from "../../hooks/usePrefs";
import { type EntryData, useVault } from "../../hooks/useVault";
import { checkPasswordBreach } from "../../util/pwned";
import { getEntryMode } from "../entry-modes";
import { usePopOut } from "../hooks/usePopOut";
import { EntryForm, type EntryFormDraft } from "../screens/CreateEntry/EntryForm";

export function EntryEditRoute() {
	const navigate = useNavigate();
	const { entryId } = useParams({ from: "/_app/vault/$entryId/edit" });
	const { entries, updateEntry, ready } = useVault();
	const { prefs } = usePrefs();
	const { registerDraftGetter, takeInitialDraft } = usePopOut();
	const [draft] = useState(() => takeInitialDraft() as EntryFormDraft | undefined);
	const entry = entries.find((e) => e.id === entryId);

	// Only bail once the vault has finished hydrating — a detached window can
	// boot straight onto this route before `entries` has loaded, and we don't
	// want to bounce off the restored route in that window.
	useEffect(() => {
		if (ready && !entry) navigate({ to: "/vault" });
	}, [ready, entry, navigate]);

	if (!entry) return null;

	const mode = getEntryMode(entry.type);

	const handleSave = async (data: EntryData) => {
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
				initialBreach={entry.type === "login" ? entry.breach : undefined}
				draftValues={draft}
				registerDraft={registerDraftGetter}
				submitLabel={`Update ${mode.label}`}
				onBack={() => navigate({ to: "/vault/$entryId", params: { entryId } })}
				onSave={handleSave}
			/>
		</div>
	);
}
