import { useLingui } from "@lingui/react/macro";
import { ExternalLink } from "lucide-react";
import type { MouseEvent } from "react";
import { usePlatform } from "../../context/PlatformContext";
import { buttonClasses } from "./ui/button";
import { cn } from "./ui/utils";

/** Opens a login's website in a new tab (the system browser on desktop and mobile). `href` must
 * come from `launchableUrl`, which only lets http(s) through. With `entryId`, the extension also
 * fills that login there. See docs/launch-and-fill.md. */
export function OpenWebsiteLink({
	href,
	entryId,
	onOpen,
}: {
	href: string;
	entryId?: string;
	onOpen?: () => void;
}) {
	const { t } = useLingui();
	const { shell } = usePlatform();

	const onClick = (e: MouseEvent) => {
		onOpen?.();
		const plain = !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
		if (!entryId || !plain || !shell?.launchLogin) return;
		e.preventDefault();
		void shell.launchLogin(entryId, href);
	};

	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer noopener"
			onClick={onClick}
			className={cn(buttonClasses({ variant: "ghost", size: "none" }), "p-1.5 rounded-md")}
			aria-label={t`Open website`}
			title={t`Open website`}
		>
			<ExternalLink className="w-3.5 h-3.5" />
		</a>
	);
}
