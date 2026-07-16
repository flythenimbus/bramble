import { Trans, useLingui } from "@lingui/react/macro";
import { KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { useVault } from "../../../../hooks/useVault";
import { useVaultRegistry } from "../../../../hooks/useVaultRegistry";
import { PasswordField } from "../../../components/ui/password-field";
import { Section } from "./primitives";

const destructiveBtn =
	"px-4 py-2 text-sm rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2";
const cancelBtn =
	"px-4 py-2 text-sm rounded-lg border border-border hover:bg-primary/5 disabled:opacity-50";

/**
 * Delete the current vault, gated on re-auth. Uses the master password when the vault has one
 * (the primary method); otherwise a security-key tap. Invariant B guarantees one of the two.
 */
export function DeleteVaultSection() {
	const { hasPasswordSlot, verifyMasterPassword, verifyWithSecurityKey, lock } = useVault();
	const { remove } = useVaultRegistry();
	const { t } = useLingui();
	const [confirming, setConfirming] = useState(false);
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Lock then remove; the router guards route on to the picker (or setup, if it was the last).
	const doDelete = async () => {
		await lock();
		await remove();
	};

	const withPassword = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		setBusy(true);
		try {
			if (await verifyMasterPassword(password)) await doDelete();
			else setError(t`That password is incorrect.`);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	};

	const withSecurityKey = async () => {
		setError(null);
		setBusy(true);
		try {
			if (await verifyWithSecurityKey()) await doDelete();
			else setError(t`Couldn't verify your security key.`);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Section icon={<Trash2 className="w-4 h-4 text-destructive" />} title={t`Delete vault`}>
			{!confirming ? (
				<button
					type="button"
					onClick={() => {
						setError(null);
						setConfirming(true);
					}}
					className="w-full px-4 py-3 text-sm rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90 active:scale-[0.99] transition-all flex items-center justify-center gap-2"
				>
					<Trash2 className="w-4 h-4" />
					<Trans>Delete this vault</Trans>
				</button>
			) : (
				<div className="space-y-3">
					<p className="text-xs text-muted-foreground">
						<Trans>
							This removes the vault from this device. Synced copies on your other devices aren't
							affected, and this can't be undone here. Confirm to continue.
						</Trans>
					</p>
					{hasPasswordSlot ? (
						<form onSubmit={withPassword} className="space-y-3">
							<PasswordField
								label={t`Master password`}
								autoFocus
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								error={error ?? undefined}
							/>
							<div className="flex gap-2">
								<button type="submit" disabled={busy || !password} className={destructiveBtn}>
									{busy ? t`Deleting…` : t`Delete this vault`}
								</button>
								<button
									type="button"
									onClick={() => setConfirming(false)}
									disabled={busy}
									className={cancelBtn}
								>
									<Trans>Cancel</Trans>
								</button>
							</div>
						</form>
					) : (
						<div className="space-y-2">
							{error && <p className="text-xs text-destructive">{error}</p>}
							<div className="flex gap-2">
								<button
									type="button"
									onClick={() => void withSecurityKey()}
									disabled={busy}
									className={destructiveBtn}
								>
									<KeyRound className="w-4 h-4" />
									{busy ? t`Waiting for your key…` : t`Confirm with security key`}
								</button>
								<button
									type="button"
									onClick={() => setConfirming(false)}
									disabled={busy}
									className={cancelBtn}
								>
									<Trans>Cancel</Trans>
								</button>
							</div>
						</div>
					)}
				</div>
			)}
		</Section>
	);
}
