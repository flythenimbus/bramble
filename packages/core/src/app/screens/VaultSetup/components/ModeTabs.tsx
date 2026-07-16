import { Trans } from "@lingui/react/macro";
import type { VaultSetupMode } from "../types";

interface ModeTabsProps {
	mode: VaultSetupMode;
	onChange: (mode: VaultSetupMode) => void;
	disabled?: boolean;
	/** Borderless pill tabs (no container background or shadow); used on mobile. */
	pill?: boolean;
	/** Adding a vault (vaults already exist): a "Restore from backup" nav action that opens the
	 * .bramble flow (which adds a new vault), shown in place of the first-run "Open existing" tab. */
	onRestore?: () => void;
	/** First-run only: show the "Open existing vault" tab (adding a parallel vault never opens the
	 * existing one). */
	showOpen?: boolean;
	/** Show the "Join a device" tab (gated to where per-vault sync is supported). */
	showJoin?: boolean;
}

export function ModeTabs({
	mode,
	onChange,
	disabled,
	pill,
	onRestore,
	showOpen,
	showJoin,
}: ModeTabsProps) {
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
			{onRestore ? (
				<Btn active={false} disabled={disabled} onClick={onRestore}>
					<Trans>Restore from backup</Trans>
				</Btn>
			) : showOpen ? (
				<Btn active={mode === "open"} disabled={disabled} onClick={() => onChange("open")}>
					<Trans>Open existing vault</Trans>
				</Btn>
			) : null}
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
