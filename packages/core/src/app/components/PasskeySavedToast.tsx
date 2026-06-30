import { useLingui } from "@lingui/react/macro";
import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { usePlatform } from "../../context/PlatformContext";

/**
 * Transient confirmation when the passkey provider saves a credential (extension only;
 * the background broadcasts the save and the shell forwards it). Mounted in AppLayout so
 * it shows over the main screen, e.g. after an "Unlock & Save" from a site's prompt.
 */
export function PasskeySavedToast() {
	const { shell } = usePlatform();
	const { t } = useLingui();
	const [message, setMessage] = useState<string | null>(null);

	useEffect(() => {
		if (!shell.onPasskeySaved) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const off = shell.onPasskeySaved((info) => {
			setMessage(
				info.created
					? t`Passkey saved as ${info.loginName}`
					: t`Passkey added to ${info.loginName}`,
			);
			clearTimeout(timer);
			timer = setTimeout(() => setMessage(null), 4000);
		});
		return () => {
			off();
			clearTimeout(timer);
		};
	}, [shell, t]);

	if (!message) return null;
	return (
		<div
			role="status"
			aria-live="polite"
			className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-3.5 py-2 rounded-lg bg-primary/10 text-primary border border-primary/20 backdrop-blur-xl shadow-lg text-sm"
		>
			<KeyRound className="w-4 h-4 shrink-0" />
			<span>{message}</span>
		</div>
	);
}
