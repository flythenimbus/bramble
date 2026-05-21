import { Shield } from "lucide-react";
import type { VaultSetupMode } from "../types";

interface SetupHeaderProps {
	mode: VaultSetupMode;
}

export function SetupHeader({ mode }: SetupHeaderProps) {
	return (
		<div className="text-center mb-8">
			<div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-primary/80 mb-4">
				<Shield className="w-9 h-9 text-primary-foreground" />
			</div>
			<h1 className="text-2xl mb-2 bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
				{mode === "create" ? "Set up your vault" : "Open your vault"}
			</h1>
			<p className="text-sm text-muted-foreground">
				{mode === "create"
					? "Choose where to store your encrypted vault and pick a master password."
					: "Point at your existing vault file and enter your master password."}
			</p>
		</div>
	);
}
