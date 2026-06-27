import { Trans, useLingui } from "@lingui/react/macro";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { useVault } from "../../../../hooks/useVault";
import { Row } from "./primitives";

export function SecurityKeysSection() {
	const { securityKeys, registerSecurityKey, revokeSecurityKey } = useVault();
	const { t } = useLingui();
	const [adding, setAdding] = useState(false);
	const [label, setLabel] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleAdd = async (e: React.SyntheticEvent) => {
		e.preventDefault();
		setError(null);
		setBusy(true);
		try {
			await registerSecurityKey(label.trim() || t`Security key`);
			setLabel("");
			setAdding(false);
		} catch (err) {
			setError(String(err instanceof Error ? err.message : err));
		} finally {
			setBusy(false);
		}
	};

	const handleRevoke = async (slotIdB64: string) => {
		setError(null);
		try {
			await revokeSecurityKey(slotIdB64);
		} catch (err) {
			setError(String(err instanceof Error ? err.message : err));
		}
	};

	return (
		<>
			<Row
				icon={<KeyRound className="w-4 h-4 text-primary" />}
				title={t`Security keys`}
				subtitle={t`Tap a security key to unlock instead of typing the master password.`}
			>
				{!adding ? (
					<button
						type="button"
						onClick={() => {
							setError(null);
							setAdding(true);
						}}
						className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98] transition-all"
					>
						<Trans>Add</Trans>
					</button>
				) : null}
			</Row>

			{securityKeys.length > 0 && (
				<ul className="ml-12 mt-2 space-y-1.5">
					{securityKeys.map((k) => (
						<li
							key={k.slotIdB64}
							className="flex items-center justify-between gap-3 text-xs rounded-md border border-border/40 px-3 py-1.5"
						>
							<span className="truncate">{k.label}</span>
							<button
								type="button"
								onClick={() => void handleRevoke(k.slotIdB64)}
								className="text-muted-foreground hover:text-destructive transition-colors"
								aria-label={t`Remove ${k.label}`}
								title={t`Remove ${k.label}`}
							>
								×
							</button>
						</li>
					))}
				</ul>
			)}

			{adding && (
				<form className="ml-12 mt-3 space-y-2" onSubmit={handleAdd}>
					<input
						type="text"
						autoFocus
						value={label}
						onChange={(e) => setLabel(e.target.value)}
						placeholder={t`Name this key (e.g. YubiKey office)`}
						className="w-full px-3 py-1.5 text-xs rounded-lg border border-border bg-transparent focus:outline-none focus:border-primary/50"
						disabled={busy}
					/>
					<div className="flex gap-2">
						<button
							type="submit"
							disabled={busy}
							className="px-3 py-1.5 text-xs rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 disabled:opacity-50"
						>
							{busy ? t`Tap your key…` : t`Register`}
						</button>
						<button
							type="button"
							onClick={() => {
								setAdding(false);
								setLabel("");
								setError(null);
							}}
							disabled={busy}
							className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-primary/5 disabled:opacity-50"
						>
							<Trans>Cancel</Trans>
						</button>
					</div>
				</form>
			)}

			{error && <p className="ml-12 mt-2 text-xs text-destructive">{error}</p>}
		</>
	);
}
