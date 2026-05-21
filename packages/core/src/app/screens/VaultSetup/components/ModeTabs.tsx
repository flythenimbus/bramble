import type { VaultSetupMode } from "../types";

interface ModeTabsProps {
	mode: VaultSetupMode;
	onChange: (mode: VaultSetupMode) => void;
	disabled?: boolean;
}

export function ModeTabs({ mode, onChange, disabled }: ModeTabsProps) {
	return (
		<div className="flex gap-2 mb-4 p-1 rounded-lg bg-muted/40 border border-border/50">
			<Tab active={mode === "create"} disabled={disabled} onClick={() => onChange("create")}>
				Create new vault
			</Tab>
			<Tab active={mode === "open"} disabled={disabled} onClick={() => onChange("open")}>
				Open existing vault
			</Tab>
		</div>
	);
}

function Tab({
	active,
	disabled,
	onClick,
	children,
}: {
	active: boolean;
	disabled?: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={`flex-1 px-3 py-2 text-sm rounded-md transition-all disabled:opacity-50 ${
				active
					? "bg-card text-foreground shadow-sm border border-border/50"
					: "text-muted-foreground hover:text-foreground"
			}`}
		>
			{children}
		</button>
	);
}
