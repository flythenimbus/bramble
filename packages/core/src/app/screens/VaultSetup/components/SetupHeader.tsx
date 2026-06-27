import { Trans, useLingui } from "@lingui/react/macro";
import { BrambleGlyph } from "../../../components/BrambleGlyph";
import type { VaultSetupMode } from "../types";

interface SetupHeaderProps {
	mode: VaultSetupMode;
	/** Mobile: storage is app-managed, so drop the "choose where to store" copy. */
	mobile?: boolean;
}

export function SetupHeader({ mode, mobile }: SetupHeaderProps) {
	const { t } = useLingui();
	const subtitle =
		mode === "create"
			? mobile
				? t`Pick a master password to protect your vault.`
				: t`Choose where to store your encrypted vault and pick a master password.`
			: mobile
				? t`Enter your master password to unlock your vault.`
				: t`Point at your existing vault file and enter your master password.`;
	return (
		<div className="text-center mb-6">
			<BrambleGlyph className="w-16 h-16 text-foreground mb-4 inline-block" />
			<h1 className="text-2xl mb-2 bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
				{mode === "create" ? <Trans>Set up your vault</Trans> : <Trans>Open your vault</Trans>}
			</h1>
			<p className={`text-muted-foreground ${mobile ? "text-base" : "text-sm"}`}>{subtitle}</p>
		</div>
	);
}
