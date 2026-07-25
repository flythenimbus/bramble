import { useLingui } from "@lingui/react/macro";
import { Check } from "lucide-react";
import { useEffect } from "react";
import { usePlatform } from "../../context/PlatformContext";
import { useToast } from "./ui/toast";

/**
 * Bridge: turns the extension's corner-prompt "committed after unlock" broadcast into a shared
 * toast. Renders nothing itself; the toast is drawn by ToastProvider's viewport. Mounted in
 * AppLayout so an "Unlock & save" that lands right after unlocking is confirmed on the screen
 * the user is already looking at (the corner card is gone by then). Twin of PasskeySavedToast.
 */
export function CornerSavedToast() {
	const { shell } = usePlatform();
	const { show } = useToast();
	const { t } = useLingui();

	useEffect(() => {
		if (!shell.onCornerSaved) return;
		return shell.onCornerSaved((info) => {
			show({
				message:
					info.kind === "update"
						? t`Password updated for ${info.hostname}`
						: t`Login saved for ${info.hostname}`,
				variant: "success",
				icon: Check,
			});
		});
	}, [shell, show, t]);

	return null;
}
