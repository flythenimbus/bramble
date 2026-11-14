import { Trans, useLingui } from "@lingui/react/macro";
import { Download, X } from "lucide-react";
import type { AppUpdateNotice } from "../hooks/useAppUpdate";
import { Button, buttonClasses } from "./ui/button";

/** The mobile update notice. Styled like DefaultManagerCard. */
export function UpdateCard({ update }: { update: AppUpdateNotice }) {
	const { t } = useLingui();
	return (
		<div className="relative shrink-0 mt-3 rounded-lg border border-border bg-muted/40 p-3 space-y-2">
			<Button
				variant="ghost"
				size="none"
				onClick={update.onDismiss}
				aria-label={t`Dismiss`}
				className="absolute top-1.5 right-1.5 p-1.5 text-muted-foreground"
			>
				<X className="w-3.5 h-3.5" />
			</Button>
			<p className="flex items-center gap-1.5 pr-6 text-sm">
				<Download className="w-4 h-4 shrink-0 text-primary" />
				{t`Version ${update.version} is available`}
			</p>
			{/* An anchor: mobile opens cross-origin links outside the app (the App Store, or the
			    browser, which downloads the APK). */}
			<a
				href={update.url}
				target="_blank"
				rel="noreferrer noopener"
				className={buttonClasses({ variant: "primary", size: "sm" })}
			>
				<Trans>Update now</Trans>
			</a>
		</div>
	);
}
