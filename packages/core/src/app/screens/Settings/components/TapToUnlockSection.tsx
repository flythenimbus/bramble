import { Trans, useLingui } from "@lingui/react/macro";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { useVault } from "../../../../hooks/useVault";
import { Button } from "../../../components/ui/button";
import { Row } from "./primitives";

export function TapToUnlockSection() {
	const { webauthnKeys, registerWebauthnKey, revokeWebauthnKey } = useVault();
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
			await registerWebauthnKey(label.trim() || t`Security key`);
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
			await revokeWebauthnKey(slotIdB64);
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
					<Button
						variant="secondary"
						size="sm"
						onClick={() => {
							setError(null);
							setAdding(true);
						}}
					>
						<Trans>Add</Trans>
					</Button>
				) : null}
			</Row>

			{webauthnKeys.length > 0 && (
				<ul className="ml-12 mt-2 space-y-1.5">
					{webauthnKeys.map((k) => (
						<li
							key={k.slotIdB64}
							className="flex items-center justify-between gap-3 text-xs rounded-md border border-border/40 px-3 py-1.5"
						>
							<span className="truncate">{k.label}</span>
							<Button
								variant="link"
								size="none"
								onClick={() => void handleRevoke(k.slotIdB64)}
								className="hover:text-destructive transition-colors"
								aria-label={t`Remove ${k.label}`}
								title={t`Remove ${k.label}`}
							>
								×
							</Button>
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
						<Button type="submit" variant="primary" size="sm" disabled={busy}>
							{busy ? t`Tap your key…` : t`Register`}
						</Button>
						<Button
							variant="secondary"
							size="sm"
							onClick={() => {
								setAdding(false);
								setLabel("");
								setError(null);
							}}
							disabled={busy}
						>
							<Trans>Cancel</Trans>
						</Button>
					</div>
				</form>
			)}

			{error && <p className="ml-12 mt-2 text-xs text-destructive">{error}</p>}
		</>
	);
}
