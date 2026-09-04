import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { usePlatform } from "../../context/PlatformContext";
import { usePrefs } from "../../hooks/usePrefs";
import { type EntryData, useVaultActions } from "../../hooks/useVault";
import { checkPasswordBreach } from "../../util/pwned";
import { getEntryMode } from "../entry-modes";
import { usePopOut } from "../hooks/usePopOut";
import { takePendingCreateEntry } from "../pending-create-entry";
import { EntryForm, type EntryFormDraft } from "../screens/CreateEntry/EntryForm";

/** Route for creating a new entry, seeding logins from the active tab origin or a pop-out draft. */
export function CreateEntryRoute() {
	const navigate = useNavigate();
	const { type } = useParams({ from: "/_app/vault/new/$type" });
	// Normalise the route param against the registry so an unknown value falls
	// back to a real mode rather than rendering a broken form.
	const entryType = getEntryMode(type).type;
	const { addEntry } = useVaultActions();
	const { shell } = usePlatform();
	const { prefs } = usePrefs();
	const { registerDraftGetter, takeInitialDraft } = usePopOut();
	// A draft handed over from a pop-out already carries its own values, so skip
	// the active-tab lookup and seed the form from it verbatim.
	const [draft] = useState(() => takeInitialDraft() as EntryFormDraft | undefined);
	// A credential captured by the mobile autofill provider, seeded as the initial
	// entry (its urls already carry the host, so the active-tab lookup is skipped too).
	const [pendingInitial] = useState(() => takePendingCreateEntry());
	// Only logins seed their website field from the active tab; other modes are
	// ready immediately. Wait until the origin is known so the form's
	// defaultValues see it on first render.
	const [defaultUrl, setDefaultUrl] = useState<string | null>(
		draft || pendingInitial || entryType !== "login" ? "" : null,
	);

	useEffect(() => {
		if (draft || pendingInitial || entryType !== "login") return;
		let cancelled = false;
		shell.getCurrentTabOrigin().then((origin) => {
			if (!cancelled) setDefaultUrl(origin ?? "");
		});
		return () => {
			cancelled = true;
		};
	}, [shell, draft, pendingInitial, entryType]);

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

	// pb-3 balances EntryForm's pt-3: the card is height-capped here and scrolls internally.
	return (
		<div className="flex-1 min-h-0 flex flex-col pb-3">
			<EntryForm
				key={entryType}
				type={entryType}
				defaultUrl={defaultUrl}
				initialEntry={pendingInitial}
				draftValues={draft}
				registerDraft={registerDraftGetter}
				onBack={() => navigate({ to: "/vault" })}
				onSave={handleSave}
			/>
		</div>
	);
}
