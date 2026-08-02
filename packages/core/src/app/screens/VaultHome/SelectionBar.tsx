import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { X } from "lucide-react";
import { useState } from "react";
import { usePlatform } from "../../../context/PlatformContext";
import type { Entry } from "../../../hooks/useVault";
import { availableBulkActions, type BulkAction, isBulkActionEnabled } from "../../bulk-actions";
import { Button } from "../../components/ui/button";
import { DropdownMenu, DropdownMenuItem } from "../../components/ui/dropdown-menu";

interface SelectionBarProps {
	/** The whole selection, including entries the filter is hiding. */
	selectedEntries: Entry[];
	/** How many of those the current filter hides; 0 when the selection is all on screen. */
	hiddenCount: number;
	allVisibleSelected: boolean;
	onSelectAll: () => void;
	/** Empties the selection but stays in selection mode; only `onExit` leaves it. */
	onDeselectAll: () => void;
	/** Leave selection mode and drop the selection. */
	onExit: () => void;
	/** An action finished: the selection is spent, but selection mode stays on. */
	onActionDone: () => void;
}

/** Bulk-action toolbar; replaces the list header while selection mode is on. */
export function SelectionBar({
	selectedEntries,
	hiddenCount,
	allVisibleSelected,
	onSelectAll,
	onDeselectAll,
	onExit,
	onActionDone,
}: SelectionBarProps) {
	const { t } = useLingui();
	const platform = usePlatform();
	const [running, setRunning] = useState<BulkAction | null>(null);

	const count = selectedEntries.length;
	const actions = availableBulkActions(platform);
	const ids = selectedEntries.map((e) => e.id);
	// Rendered only while picked, so a dialog's own state resets between runs and an
	// action that isn't in use costs nothing.
	const Dialog = running?.Dialog;

	return (
		<div
			// Wraps rather than overflows: on a narrow phone the count plus three controls
			// don't fit on one line, and the translated labels are wider still
			// ("Désélectionner tout"). The card clips overflow, so the exit button has to
			// stay reachable.
			className="shrink-0 px-4 py-2 border-b border-border/50 flex flex-wrap items-center gap-x-3 gap-y-1"
		>
			<div className="min-w-0">
				<p className="text-sm whitespace-nowrap">
					<Plural value={count} one="# selected" other="# selected" />
				</p>
				{/* Bulk actions run on the whole selection, so an off-screen part of it
					can never go unmentioned. */}
				{hiddenCount > 0 && (
					<p className="text-[11px] text-muted-foreground truncate">
						<Plural
							value={hiddenCount}
							one="# hidden by the current filter"
							other="# hidden by the current filter"
						/>
					</p>
				)}
			</div>

			<div className="ml-auto flex items-center gap-2 shrink-0">
				<Button variant="link" size="sm" onClick={allVisibleSelected ? onDeselectAll : onSelectAll}>
					{allVisibleSelected ? <Trans>Deselect all</Trans> : <Trans>Select all</Trans>}
				</Button>
				{/* One menu over the bulk-action registry: a new action is a descriptor in
					app/bulk-actions, not another button competing for the toolbar. */}
				<DropdownMenu label={<Trans>Actions</Trans>} disabled={count === 0}>
					{actions.map((action) => {
						const Icon = action.icon;
						return (
							<DropdownMenuItem
								key={action.id}
								icon={
									<Icon
										className={`w-3 h-3 ${action.destructive ? "text-destructive" : "text-muted-foreground"}`}
									/>
								}
								destructive={action.destructive}
								disabled={!isBulkActionEnabled(action, selectedEntries)}
								onSelect={() => setRunning(action)}
							>
								{action.label}
							</DropdownMenuItem>
						);
					})}
				</DropdownMenu>
				{/* The only way out of selection mode, so it gets a full touch target on a
					coarse pointer (32px is under both the iOS and Android minimums). */}
				<Button
					variant="ghost"
					size="icon"
					onClick={onExit}
					aria-label={t`Done selecting`}
					className="pointer-coarse:p-3.5"
				>
					<X className="w-4 h-4" />
				</Button>
			</div>

			{Dialog && (
				<Dialog
					open
					onClose={() => setRunning(null)}
					onDone={() => {
						setRunning(null);
						onActionDone();
					}}
					ids={ids}
					entries={selectedEntries}
					hiddenCount={hiddenCount}
				/>
			)}
		</div>
	);
}
