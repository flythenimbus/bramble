import { Trans, useLingui } from "@lingui/react/macro";
import { BadgeCheck, X } from "lucide-react";
import { Button } from "./ui/button";

/** The extension's offer to switch the browser's own password manager off (#135). Shown until it
 * is taken or dismissed; Settings keeps the switch either way. Styled like ReviewNudgeCard. */
export function DefaultManagerCard({
	onAccept,
	onDismiss,
}: {
	onAccept: () => void;
	onDismiss: () => void;
}) {
	const { t } = useLingui();
	return (
		<div className="relative shrink-0 mt-3 rounded-lg border border-border bg-muted/40 p-3 space-y-2">
			<Button
				variant="ghost"
				size="none"
				onClick={onDismiss}
				aria-label={t`Dismiss`}
				className="absolute top-1.5 right-1.5 p-1.5 text-muted-foreground"
			>
				<X className="w-3.5 h-3.5" />
			</Button>
			<p className="flex items-center gap-1.5 pr-6 text-sm">
				<BadgeCheck className="w-4 h-4 shrink-0 text-primary" />
				<Trans>Make Bramble your default password manager?</Trans>
			</p>
			<p className="pr-6 text-xs text-muted-foreground">
				<Trans>Turns off the browser's own password manager</Trans>
			</p>
			<Button variant="primary" size="sm" onClick={onAccept}>
				<Trans>Make default</Trans>
			</Button>
		</div>
	);
}
