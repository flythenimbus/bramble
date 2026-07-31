import type { ReactNode } from "react";
import { useCan, usePlatform } from "../../context/PlatformContext";

/**
 * A tappable row that opens the OS file picker. Shared by the import and restore screens,
 * which is the point: the two used to carry their own copies, and the mobile `accept` rule
 * was fixed in one and unknown to the other (github issue #36).
 *
 * Two behaviours live here rather than in the callers, because both are easy to omit and
 * neither fails loudly: arming the auto-lock grace before the picker backgrounds the app,
 * and clearing the input value afterwards so re-picking the same file fires `change` again.
 */
export function FilePickerRow({
	accept,
	icon,
	title,
	subtitle,
	trailing,
	onPick,
}: {
	/** Extensions to filter by on desktop. Dropped on mobile, where native pickers match on
	 * MIME type and grey out anything they can't map. */
	accept?: string;
	icon: ReactNode;
	title: ReactNode;
	subtitle: ReactNode;
	trailing?: ReactNode;
	onPick: (file: File | undefined) => Promise<void> | void;
}) {
	const { shell } = usePlatform();
	const filterByExtension = useCan("filePickerAcceptFilter");

	return (
		<label className="flex items-center gap-3 p-4 rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm cursor-pointer hover:border-border hover:bg-card/80 active:scale-[0.99] transition-all">
			<input
				type="file"
				accept={filterByExtension ? accept : undefined}
				className="hidden"
				// Keep the vault unlocked while the OS picker backgrounds the app (mobile).
				onClick={() => shell.notifyFilePickerOpening?.()}
				onChange={(e) => {
					// Reset the value after handling so re-picking the same file fires onChange again.
					const input = e.currentTarget;
					void Promise.resolve(onPick(input.files?.[0])).finally(() => {
						input.value = "";
					});
				}}
			/>
			<div className="flex items-center justify-center w-10 h-10 rounded-lg bg-linear-to-br from-primary/20 to-primary/10 shrink-0">
				{icon}
			</div>
			<div className="min-w-0 flex-1">
				<p className="text-sm">{title}</p>
				<p className="text-xs text-muted-foreground truncate">{subtitle}</p>
			</div>
			{trailing}
		</label>
	);
}
