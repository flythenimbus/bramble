import { Trans } from "@lingui/react/macro";
import { Database } from "lucide-react";

export function Header({ subtitle }: { subtitle: string }) {
	return (
		<div className="text-center mb-6">
			<div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-primary to-primary/80 mb-3">
				<Database className="w-7 h-7 text-primary-foreground" />
			</div>
			<h1 className="text-2xl">
				<Trans>Import data</Trans>
			</h1>
			<p className="text-sm text-muted-foreground mt-1">{subtitle}</p>
		</div>
	);
}
