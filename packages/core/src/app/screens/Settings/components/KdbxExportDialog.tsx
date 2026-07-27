import { Trans, useLingui } from "@lingui/react/macro";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useVault } from "../../../../hooks/useVault";
import { Button } from "../../../components/ui/button";
import { MasterPasswordMeter } from "../../../components/ui/master-password-meter";
import { Modal } from "../../../components/ui/modal";
import { PasswordField } from "../../../components/ui/password-field";

/**
 * Collects the password for a KeePass export. It protects the exported file only, so it is
 * deliberately NOT the master password: the file is meant to be opened by another manager.
 * Confirmed twice because nothing can recover it — we never store it.
 */
export function KdbxExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
	const { t } = useLingui();
	const { exportKdbx } = useVault();
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const reset = () => {
		setPassword("");
		setConfirm("");
		setError(null);
	};

	const close = () => {
		reset();
		onClose();
	};

	const submit = async (e: React.SyntheticEvent) => {
		e.preventDefault();
		if (!password) {
			setError(t`Choose a password for the exported file.`);
			return;
		}
		if (password !== confirm) {
			setError(t`Those passwords don't match.`);
			return;
		}
		setError(null);
		setBusy(true);
		try {
			await exportKdbx(password);
			close();
		} catch (err) {
			setError(err instanceof Error ? err.message : t`Couldn't write the .kdbx file.`);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal open={open} onClose={close} className="max-w-md">
			<form onSubmit={submit} className="p-6 space-y-4">
				<div className="space-y-1.5">
					<h2 className="text-lg">
						<Trans>Export as KeePass (.kdbx)</Trans>
					</h2>
					<p className="text-sm text-muted-foreground">
						<Trans>
							Pick a password for the exported file. It's separate from your master password, and
							it's the only way to open the file — we don't keep a copy.
						</Trans>
					</p>
				</div>
				<PasswordField
					label={t`Password for the file`}
					autoFocus
					value={password}
					onChange={(e) => setPassword(e.target.value)}
				/>
				<MasterPasswordMeter value={password} />
				<PasswordField
					label={t`Confirm password`}
					value={confirm}
					onChange={(e) => setConfirm(e.target.value)}
					error={error ?? undefined}
				/>
				<div className="flex items-center justify-end gap-3 pt-1">
					<Button variant="secondary" size="sm" type="button" onClick={close} disabled={busy}>
						<Trans>Cancel</Trans>
					</Button>
					<Button variant="primary" size="sm" type="submit" disabled={busy}>
						{busy ? (
							<>
								<Loader2 className="w-3.5 h-3.5 animate-spin" />
								<Trans>Exporting…</Trans>
							</>
						) : (
							<Trans>Export</Trans>
						)}
					</Button>
				</div>
			</form>
		</Modal>
	);
}
