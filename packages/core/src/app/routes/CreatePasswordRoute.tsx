import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { usePlatform } from "../../context/PlatformContext";
import { useVault } from "../../hooks/useVault";
import { CreatePassword } from "../screens/CreatePassword/CreatePassword";

export function CreatePasswordRoute() {
	const navigate = useNavigate();
	const { addEntry } = useVault();
	const { shell } = usePlatform();
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

	return (
		<div className="flex-1 overflow-y-auto">
			<CreatePassword
				defaultUrl={defaultUrl}
				onBack={() => navigate({ to: "/vault" })}
				onSave={(data) => addEntry(data)}
			/>
		</div>
	);
}
