import { Trans, useLingui } from "@lingui/react/macro";
import { KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { useVault } from "../../../../hooks/useVault";
import { Button } from "../../../components/ui/button";
import { PasswordField } from "../../../components/ui/password-field";
import { Section } from "./primitives";

/**
 * Delete the current vault. All the re-auth + erase logic lives in useVault.deleteVault, which
 * verifies then deletes atomically; this component only collects the credential. deleteVault
 * uses the master password when the vault has one, otherwise a tap-to-unlock key.
 */
export function DeleteVaultSection() {
	const { hasPasswordSlot, deleteVault } = useVault();
	const { t } = useLingui();
	const [confirming, setConfirming] = useState(false);
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// A false return means the credential didn't verify (nothing was deleted); a throw means the
	// security-key ceremony errored. On success the vault is gone and the guards route us away.
	const withPassword = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		setBusy(true);
		try {
			if (!(await deleteVault({ password }))) setError(t`That password is incorrect.`);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	};

	const withWebauthnKey = async () => {
		setError(null);
		setBusy(true);
		try {
			if (!(await deleteVault({ webauthnKey: true }))) setError(t`Couldn't verify your key.`);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Section icon={<Trash2 className="w-4 h-4 text-destructive" />} title={t`Delete vault`}>
			{!confirming ? (
				<Button
					variant="destructive"
					size="none"
					fullWidth
					onClick={() => {
						setError(null);
						setConfirming(true);
					}}
					className="px-4 py-3 text-sm active:scale-[0.99]"
				>
					<Trash2 className="w-4 h-4" />
					<Trans>Delete this vault</Trans>
				</Button>
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
								<Button
									type="submit"
									variant="destructive"
									size="none"
									disabled={busy || !password}
									className="px-4 py-2 text-sm"
								>
									{busy ? t`Deleting…` : t`Delete this vault`}
								</Button>
								<Button
									variant="secondary"
									size="none"
									onClick={() => setConfirming(false)}
									disabled={busy}
									className="px-4 py-2 text-sm"
								>
									<Trans>Cancel</Trans>
								</Button>
							</div>
						</form>
					) : (
						<div className="space-y-2">
							{error && <p className="text-xs text-destructive">{error}</p>}
							<div className="flex gap-2">
								<Button
									variant="destructive"
									size="none"
									onClick={() => void withWebauthnKey()}
									disabled={busy}
									className="px-4 py-2 text-sm"
								>
									<KeyRound className="w-4 h-4" />
									{busy ? t`Waiting for your key…` : t`Confirm with your key`}
								</Button>
								<Button
									variant="secondary"
									size="none"
									onClick={() => setConfirming(false)}
									disabled={busy}
									className="px-4 py-2 text-sm"
								>
									<Trans>Cancel</Trans>
								</Button>
							</div>
						</div>
					)}
				</div>
			)}
		</Section>
	);
}
