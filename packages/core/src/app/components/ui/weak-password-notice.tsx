import { Trans } from "@lingui/react/macro";
import { Checkbox } from "./checkbox";

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
			<Checkbox checked={accepted} onChange={onAccept}>
				<Trans>Use this password anyway</Trans>
			</Checkbox>
		</div>
	);
}
