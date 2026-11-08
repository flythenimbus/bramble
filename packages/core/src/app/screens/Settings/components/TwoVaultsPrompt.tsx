import { Trans } from "@lingui/react/macro";

export type TwoVaultsChoice = "combine" | "separate";

/**
 * Both sides hold entries: combine into the desktop's vault, or keep them separate. Neither is
 * preselected, by the user's decision. Matches the mockup approved in the design.
 */
export function TwoVaultsPrompt({
	browserName,
	browserEntries,
	desktopName,
	desktopEntries,
	otherDevices,
	choice,
	onChoice,
}: {
	browserName: string;
	browserEntries: number;
	desktopName: string;
	desktopEntries: number | null;
	otherDevices: string[];
	choice: TwoVaultsChoice | null;
	onChoice: (choice: TwoVaultsChoice) => void;
}) {
	return (
		<div className="space-y-3">
			<p className="text-xs text-muted-foreground">
				{desktopEntries === null ? (
					<Trans>
						This browser has {browserName} ({browserEntries} entries). The desktop app has{" "}
						{desktopName}.
					</Trans>
				) : (
					<Trans>
						This browser has {browserName} ({browserEntries} entries). The desktop app has{" "}
						{desktopName} ({desktopEntries} entries).
					</Trans>
				)}
			</p>
			<label className="flex gap-2 rounded-lg border border-border p-3 text-xs">
				<input
					type="radio"
					name="two-vaults"
					checked={choice === "combine"}
					onChange={() => onChoice("combine")}
				/>
				<span className="space-y-1">
					<span className="block text-sm">
						<Trans>Combine into one</Trans>
					</span>
					<span className="block text-muted-foreground">
						<Trans>
							Moves {browserName}'s entries and files into {desktopName}. Exact duplicates are
							skipped; near-duplicates are held for you to review.
						</Trans>
					</span>
					<span className="block text-muted-foreground">
						<Trans>This browser will unlock with the desktop app's master password.</Trans>
					</span>
				</span>
			</label>
			<label className="flex gap-2 rounded-lg border border-border p-3 text-xs">
				<input
					type="radio"
					name="two-vaults"
					checked={choice === "separate"}
					onChange={() => onChoice("separate")}
				/>
				<span className="space-y-1">
					<span className="block text-sm">
						<Trans>Keep them separate</Trans>
					</span>
					<span className="block text-muted-foreground">
						<Trans>
							Adds {desktopName} next to {browserName}. Switch between them from the vault menu.
						</Trans>
					</span>
				</span>
			</label>
			<OtherDevicesWarning browserName={browserName} otherDevices={otherDevices} />
		</div>
	);
}

/** Combining moves only this browser, which the other devices on its vault should not be surprised by. */
export function OtherDevicesWarning({
	browserName,
	otherDevices,
}: {
	browserName: string;
	otherDevices: string[];
}) {
	if (otherDevices.length === 0) return null;
	const others = otherDevices.join(", ");
	return (
		<p className="text-xs text-warning">
			<Trans>
				{browserName} also syncs with {others}. Combining moves only this browser; they stay on{" "}
				{browserName}.
			</Trans>
		</p>
	);
}
