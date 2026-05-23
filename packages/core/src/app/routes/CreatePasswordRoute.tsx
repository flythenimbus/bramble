import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { usePlatform } from "../../context/PlatformContext";
import { usePrefs } from "../../hooks/usePrefs";
import { type EntryData, useVault } from "../../hooks/useVault";
import { checkPasswordBreach } from "../../util/pwned";
import { CreatePassword } from "../screens/CreatePassword/CreatePassword";

export function CreatePasswordRoute() {
	const navigate = useNavigate();
	const { addEntry } = useVault();
	const { shell } = usePlatform();
	const { prefs } = usePrefs();
	// Wait until the active tab's origin is known before mounting the form so
	// react-hook-form's defaultValues see it on first render.
	const [defaultUrl, setDefaultUrl] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		shell.getCurrentTabOrigin().then((origin) => {
			if (!cancelled) setDefaultUrl(origin ?? "");
		});
		return () => {
			cancelled = true;
		};
	}, [shell]);

	if (defaultUrl === null) return null;

	const handleSave = async (data: EntryData) => {
		const breach = prefs.breachCheckEnabled ? await checkPasswordBreach(data.password) : undefined;
		await addEntry({ ...data, breach });
	};

	return (
		<div className="flex-1 overflow-y-auto">
			<CreatePassword
				defaultUrl={defaultUrl}
				onBack={() => navigate({ to: "/vault" })}
				onSave={handleSave}
			/>
		</div>
	);
}
