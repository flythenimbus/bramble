import { Trans } from "@lingui/react/macro";
import type { VaultSetupMode } from "../types";

interface ModeTabsProps {
	mode: VaultSetupMode;
	onChange: (mode: VaultSetupMode) => void;
	disabled?: boolean;
	/** Borderless pill tabs (no container background or shadow); used on mobile. */
	pill?: boolean;
	/** Show the "Restore from backup" tab; its panel is the .bramble restore flow rendered inline
	 * (not a page swap), so the tabs stay put. Same experience in first-run and adding views. */
	showRestore?: boolean;
	/** Show the "Join a device" tab (gated to where per-vault sync is supported). */
	showJoin?: boolean;
}

export function ModeTabs({ mode, onChange, disabled, pill, showRestore, showJoin }: ModeTabsProps) {
	const Btn = pill ? PillTab : Tab;
	return (
		<div
			className={
				pill
					? "flex gap-4 mb-5 px-2"
					: "flex gap-2 mb-4 p-1 rounded-lg bg-muted/40 border border-border/50"
			}
		>
			<Btn active={mode === "create"} disabled={disabled} onClick={() => onChange("create")}>
				<Trans>Create new vault</Trans>
			</Btn>
			{showRestore && (
				<Btn active={mode === "restore"} disabled={disabled} onClick={() => onChange("restore")}>
					<Trans>Restore from backup</Trans>
				</Btn>
			)}
			{showJoin && (
				<Btn active={mode === "join"} disabled={disabled} onClick={() => onChange("join")}>
					<Trans>Join a device</Trans>
				</Btn>
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

function Tab({ active, disabled, onClick, children }: TabProps) {
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

function PillTab({ active, disabled, onClick, children }: TabProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={`flex-1 px-4 py-2 text-sm rounded-full border-2 transition-all disabled:opacity-50 ${
				active
					? "border-foreground text-foreground"
					: "border-transparent text-muted-foreground hover:text-foreground"
			}`}
		>
			{children}
		</button>
	);
}
