import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { usePlatform } from "../../context/PlatformContext";
import { usePrefs } from "../../hooks/usePrefs";
import { type EntryData, useVault } from "../../hooks/useVault";
import { checkPasswordBreach } from "../../util/pwned";
import { usePopOut } from "../hooks/usePopOut";
import { CreatePassword, type CreatePasswordDraft } from "../screens/CreatePassword/CreatePassword";

export function CreatePasswordRoute() {
	const navigate = useNavigate();
	const { addEntry } = useVault();
	const { shell } = usePlatform();
	const { prefs } = usePrefs();
	const { registerDraftGetter, takeInitialDraft } = usePopOut();
	// A draft handed over from a pop-out already carries its own url, so skip
	// the active-tab lookup and seed the form from it verbatim.
	const [draft] = useState(() => takeInitialDraft() as CreatePasswordDraft | undefined);
	// Wait until the active tab's origin is known before mounting the form so
	// react-hook-form's defaultValues see it on first render.
	const [defaultUrl, setDefaultUrl] = useState<string | null>(draft ? "" : null);

	useEffect(() => {
		if (draft) return;
		let cancelled = false;
		shell.getCurrentTabOrigin().then((origin) => {
			if (!cancelled) setDefaultUrl(origin ?? "");
		});
		return () => {
			cancelled = true;
		};
	}, [shell, draft]);

	if (defaultUrl === null) return null;

	const handleSave = async (data: EntryData) => {
		const breach = prefs.breachCheckEnabled ? await checkPasswordBreach(data.password) : undefined;
		await addEntry({ ...data, breach });
	};

	return (
		<div className="flex-1 overflow-y-auto">
			<CreatePassword
				defaultUrl={defaultUrl}
				draftValues={draft}
				registerDraft={registerDraftGetter}
				onBack={() => navigate({ to: "/vault" })}
				onSave={handleSave}
			/>
		</div>
	);
}
