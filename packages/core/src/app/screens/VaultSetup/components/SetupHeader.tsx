import { Trans, useLingui } from "@lingui/react/macro";
import { BrambleGlyph } from "../../../components/BrambleGlyph";
import type { VaultSetupMode } from "../types";

interface SetupHeaderProps {
	mode: VaultSetupMode;
	/** Mobile: storage is app-managed, so drop the "choose where to store" copy. */
	mobile?: boolean;
	/** Adding a parallel vault (vaults already exist), not first-run setup. */
	adding?: boolean;
}

export function SetupHeader({ mode, mobile, adding }: SetupHeaderProps) {
	const { t } = useLingui();
	const subtitle =
		mode === "join"
			? t`Enter the pairing code from your other device to sync its vault onto this one.`
			: mode === "restore"
				? t`Open an encrypted .bramble backup and make it the vault on this device.`
				: adding
					? t`Create a new vault alongside your existing ones, with its own master password.`
					: mobile
						? t`Pick a master password to protect your vault.`
						: t`Choose where to store your encrypted vault and pick a master password.`;
	return (
		<div className="text-center mb-6">
			<BrambleGlyph className="w-16 h-16 text-foreground mb-4 inline-block" />
			<h1 className="text-2xl mb-2 bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
				{mode === "join" ? (
					<Trans>Join a device</Trans>
				) : mode === "restore" ? (
					<Trans>Restore a backup</Trans>
				) : adding ? (
					<Trans>Add a vault</Trans>
				) : (
					<Trans>Set up your vault</Trans>
				)}
			</h1>
			<p className={`text-muted-foreground ${mobile ? "text-base" : "text-sm"}`}>{subtitle}</p>
		</div>
	);
}
