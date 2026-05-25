import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { usePlatform } from "../../context/PlatformContext";
import { usePrefs } from "../../hooks/usePrefs";
import { type EntryData, useVault } from "../../hooks/useVault";
import { checkPasswordBreach } from "../../util/pwned";
import { getEntryMode } from "../entry-modes";
import { usePopOut } from "../hooks/usePopOut";
import { EntryForm, type EntryFormDraft } from "../screens/CreateEntry/EntryForm";

export function CreateEntryRoute() {
	const navigate = useNavigate();
	const { type } = useParams({ from: "/_app/vault/new/$type" });
	// Normalise the route param against the registry so an unknown value falls
	// back to a real mode rather than rendering a broken form.
	const entryType = getEntryMode(type).type;
	const { addEntry } = useVault();
	const { shell } = usePlatform();
	const { prefs } = usePrefs();
	const { registerDraftGetter, takeInitialDraft } = usePopOut();
	// A draft handed over from a pop-out already carries its own values, so skip
	// the active-tab lookup and seed the form from it verbatim.
	const [draft] = useState(() => takeInitialDraft() as EntryFormDraft | undefined);
	// Only logins seed their website field from the active tab; other modes are
	// ready immediately. Wait until the origin is known so the form's
	// defaultValues see it on first render.
	const [defaultUrl, setDefaultUrl] = useState<string | null>(
		draft || entryType !== "login" ? "" : null,
	);

	useEffect(() => {
		if (draft || entryType !== "login") return;
		let cancelled = false;
		shell.getCurrentTabOrigin().then((origin) => {
			if (!cancelled) setDefaultUrl(origin ?? "");
		});
		return () => {
			cancelled = true;
		};
	}, [shell, draft, entryType]);

	if (defaultUrl === null) return null;

	const handleSave = async (data: EntryData) => {
		if (data.type === "login") {
			const breach = prefs.breachCheckEnabled
				? await checkPasswordBreach(data.password)
				: undefined;
			await addEntry({ ...data, breach });
			return;
		}
		await addEntry(data);
	};

	return (
		<div className="flex-1 overflow-y-auto">
			<EntryForm
				key={entryType}
				type={entryType}
				defaultUrl={defaultUrl}
				draftValues={draft}
				registerDraft={registerDraftGetter}
				onBack={() => navigate({ to: "/vault" })}
				onSave={handleSave}
			/>
		</div>
	);
}
