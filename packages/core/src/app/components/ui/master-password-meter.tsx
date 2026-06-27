import { Trans } from "@lingui/react/macro";
import { masterPasswordStrength } from "../../../util/master-password-strength";

interface MasterPasswordMeterProps {
	value: string;
}

/** Master-password strength bar, hidden while the field is empty. */
export function MasterPasswordMeter({ value }: MasterPasswordMeterProps) {
	if (!value) return null;
	const s = masterPasswordStrength(value);
	const barColor = s.id >= 3 ? "bg-primary" : s.id === 2 ? "bg-yellow-500" : "bg-destructive";
	const textColor =
		s.id >= 3 ? "text-primary" : s.id === 2 ? "text-yellow-500" : "text-destructive";
	return (
		<div className="mt-2">
			<div className="flex items-center justify-between mb-1.5">
				<span className="text-xs text-muted-foreground">
					<Trans>Strength</Trans>
				</span>
				<span className={`text-xs ${textColor}`}>{s.label}</span>
			</div>
			<div className="h-1.5 bg-muted rounded-full overflow-hidden">
				<div
					className={`h-full transition-all duration-300 ${barColor}`}
					style={{ width: `${((s.id + 1) / 4) * 100}%` }}
				/>
			</div>
		</div>
	);
}
