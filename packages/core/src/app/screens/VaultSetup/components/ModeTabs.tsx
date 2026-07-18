import { Trans } from "@lingui/react/macro";
import { Button } from "../../../components/ui/button";
import type { VaultSetupMode } from "../types";

interface ModeTabsProps {
	mode: VaultSetupMode;
	onChange: (mode: VaultSetupMode) => void;
	disabled?: boolean;
	/** Show the "Restore from backup" tab; its panel is the .bramble restore flow rendered inline
	 * (not a page swap), so the tabs stay put. Same experience in first-run and adding views. */
	showRestore?: boolean;
	/** Show the "Join a device" tab. */
	showJoin?: boolean;
}

export function ModeTabs({ mode, onChange, disabled, showRestore, showJoin }: ModeTabsProps) {
	return (
		<div className="flex gap-2 mb-4 p-1 rounded-lg bg-muted/40 border border-border/50">
			<Tab active={mode === "create"} disabled={disabled} onClick={() => onChange("create")}>
				<Trans>Create new vault</Trans>
			</Tab>
			{showRestore && (
				<Tab active={mode === "restore"} disabled={disabled} onClick={() => onChange("restore")}>
					<Trans>Restore from backup</Trans>
				</Tab>
			)}
			{showJoin && (
				<Tab active={mode === "join"} disabled={disabled} onClick={() => onChange("join")}>
					<Trans>Join a device</Trans>
				</Tab>
			)}
		</div>
	);
}

interface TabProps {
	active: boolean;
	disabled?: boolean;
	onClick: () => void;
	children: React.ReactNode;
}

// Segmented-control tab: a subtle container (in ModeTabs) with the active tab raised as a card.
// leading-tight + text-center keep a two-line label (e.g. "Create new vault" on a narrow phone)
// neatly stacked rather than a lopsided pill.
function Tab({ active, disabled, onClick, children }: TabProps) {
	return (
		<Button
			variant="link"
			size="none"
			onClick={onClick}
			disabled={disabled}
			className={`flex-1 px-3 py-2 text-sm leading-tight text-center rounded-md transition-all disabled:opacity-50 ${
				active
					? "bg-card text-foreground shadow-sm border border-border/50"
					: "text-muted-foreground hover:text-foreground"
			}`}
		>
			{children}
		</Button>
	);
}
