import { Check } from "lucide-react";
import { cn } from "./utils";

interface WeakPasswordNoticeProps {
	message: string;
	accepted: boolean;
	onAccept: (next: boolean) => void;
}

/** Non-blocking warning for a weak (but allowed) master password; proceeding is an explicit opt-in. */
export function WeakPasswordNotice({ message, accepted, onAccept }: WeakPasswordNoticeProps) {
	return (
		<div className="rounded-md p-3 bg-yellow-500/5 border border-yellow-500/30 text-xs space-y-2.5">
			<p className="text-muted-foreground">
				<span className="text-yellow-500">⚠</span> {message}
			</p>
			<label className="flex items-center gap-2 cursor-pointer select-none text-[11px] text-foreground">
				<input
					type="checkbox"
					checked={accepted}
					onChange={(e) => onAccept(e.target.checked)}
					className="peer sr-only"
				/>
				<span
					className={cn(
						"flex items-center justify-center w-4 h-4 rounded border transition-colors",
						"peer-focus-visible:ring-2 peer-focus-visible:ring-primary/50",
						accepted ? "bg-primary border-primary" : "border-border bg-transparent",
					)}
				>
					{accepted && <Check className="w-3 h-3 text-primary-foreground" strokeWidth={3} />}
				</span>
				Use this password anyway
			</label>
		</div>
	);
}
