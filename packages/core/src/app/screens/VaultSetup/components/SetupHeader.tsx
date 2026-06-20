import { BrambleGlyph } from "../../../components/BrambleGlyph";
import type { VaultSetupMode } from "../types";

interface SetupHeaderProps {
	mode: VaultSetupMode;
	/** Mobile: storage is app-managed, so drop the "choose where to store" copy. */
	mobile?: boolean;
}

export function SetupHeader({ mode, mobile }: SetupHeaderProps) {
	const subtitle =
		mode === "create"
			? mobile
				? "Pick a master password to protect your vault."
				: "Choose where to store your encrypted vault and pick a master password."
			: mobile
				? "Enter your master password to unlock your vault."
				: "Point at your existing vault file and enter your master password.";
	return (
		<div className="text-center mb-6">
			<BrambleGlyph className="w-16 h-16 text-foreground mb-4 inline-block" />
			<h1 className="text-2xl mb-2 bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
				{mode === "create" ? "Set up your vault" : "Open your vault"}
			</h1>
			<p className={`text-muted-foreground ${mobile ? "text-base" : "text-sm"}`}>{subtitle}</p>
		</div>
	);
}
