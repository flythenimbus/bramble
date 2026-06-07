
interface SectionProps {
	icon: React.ReactNode;
	title: string;
	children: React.ReactNode;
}

export function Section({ icon, title, children }: SectionProps) {
	return (
		<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
			<div className="px-4 py-3 border-b border-border/50">
				<h3 className="text-sm flex items-center gap-2">
					{icon}
					{title}
				</h3>
			</div>
			<div className="p-4 space-y-4">{children}</div>
		</div>
	);
}

interface RowProps {
	icon: React.ReactNode;
	title: string;
	subtitle: string;
	children: React.ReactNode;
}

export function Row({ icon, title, subtitle, children }: RowProps) {
	return (
		<div className="flex items-center justify-between gap-3">
			<div className="flex items-start gap-3 min-w-0">
				<div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 shrink-0">
					{icon}
				</div>
				<div className="min-w-0">
					<p className="text-sm">{title}</p>
					<p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
				</div>
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	);
}

interface ToggleProps {
	checked: boolean;
	onChange: (next: boolean) => void;
	label: string;
	disabled?: boolean;
}

export function Toggle({ checked, onChange, label, disabled = false }: ToggleProps) {
	return (
		<button
			type="button"
			onClick={() => onChange(!checked)}
			disabled={disabled}
			aria-label={label}
			aria-pressed={checked}
			className={`relative w-11 h-6 rounded-full border transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
				checked ? "bg-primary border-primary/20" : "bg-muted border-border"
			}`}
		>
			<span
				className={`absolute top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-card shadow-sm transition-all ${
					checked ? "left-5 dark:bg-primary-foreground" : "left-0.5 dark:bg-card-foreground"
				}`}
			/>
		</button>
	);
}
