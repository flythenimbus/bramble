import { useLingui } from "@lingui/react/macro";
import { usePasswordStrength } from "../../../hooks/usePasswordStrength";
import { MIN_RECOMMENDED_SCORE } from "../../../util/password-strength";

interface PasswordStrengthMeterProps {
	value: string;
	/** Caption above the bar. Defaults to "Strength". */
	label?: string;
	/** Reads out as breached instead of scoring: a leaked password is weak whatever zxcvbn says. */
	breached?: boolean;
	className?: string;
}

/** Password strength bar, hidden until zxcvbn has scored a non-empty field. */
export function PasswordStrengthMeter({
	value,
	label,
	breached,
	className = "mt-2",
}: PasswordStrengthMeterProps) {
	const { t } = useLingui();
	const score = usePasswordStrength(value);
	if (!value || score === null) return null;

	const tone =
		breached || score < 2 ? "destructive" : score < MIN_RECOMMENDED_SCORE ? "warn" : "ok";
	const barColor =
		tone === "ok" ? "bg-primary" : tone === "warn" ? "bg-yellow-500" : "bg-destructive";
	const textColor =
		tone === "ok" ? "text-primary" : tone === "warn" ? "text-yellow-500" : "text-destructive";
	// zxcvbn's five tiers, weakest first.
	const readout = [t`Very weak`, t`Weak`, t`Fair`, t`Strong`, t`Very strong`][score];

	return (
		<div className={className}>
			<div className="flex items-center justify-between mb-1.5">
				<span className="text-xs text-muted-foreground">{label ?? t`Strength`}</span>
				<span className={`text-xs ${textColor}`}>{breached ? t`Breached` : readout}</span>
			</div>
			<div className="h-1.5 bg-muted rounded-full overflow-hidden">
				<div
					className={`h-full transition-all duration-300 ${barColor}`}
					style={{ width: breached ? "5%" : `${((score + 1) / 5) * 100}%` }}
				/>
			</div>
		</div>
	);
}
