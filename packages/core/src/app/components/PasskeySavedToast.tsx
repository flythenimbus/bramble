import { useLingui } from "@lingui/react/macro";
import { KeyRound } from "lucide-react";
import { useEffect } from "react";
import { usePlatform } from "../../context/PlatformContext";
import { useToast } from "./ui/toast";

/**
 * Bridge: turns the extension's passkey-provider "saved" broadcast into a shared toast.
 * Renders nothing itself; the toast is drawn by ToastProvider's viewport. Mounted in
 * AppLayout so it's live on the main screen (e.g. after an "Unlock & Save").
 */
export function PasskeySavedToast() {
	const { shell } = usePlatform();
	const { show } = useToast();
	const { t } = useLingui();

	useEffect(() => {
		if (!shell.onPasskeySaved) return;
		return shell.onPasskeySaved((info) => {
			show({
				message: info.created
					? t`Passkey saved as ${info.loginName}`
					: t`Passkey added to ${info.loginName}`,
				variant: "success",
				icon: KeyRound,
			});
		});
	}, [shell, show, t]);

	return null;
}
