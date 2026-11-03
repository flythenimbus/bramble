import { useLingui } from "@lingui/react/macro";
import { ExternalLink } from "lucide-react";
import { buttonClasses } from "./ui/button";
import { cn } from "./ui/utils";

/** Opens a login's website in a new tab (the system browser on desktop and mobile). `href` must
 * come from `launchableUrl`, which only lets http(s) through. */
export function OpenWebsiteLink({ href, onOpen }: { href: string; onOpen?: () => void }) {
	const { t } = useLingui();
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer noopener"
			onClick={onOpen}
			className={cn(buttonClasses({ variant: "ghost", size: "none" }), "p-1.5 rounded-md")}
			aria-label={t`Open website`}
			title={t`Open website`}
		>
			<ExternalLink className="w-3.5 h-3.5" />
		</a>
	);
}
