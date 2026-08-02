import { Trans, useLingui } from "@lingui/react/macro";
import { Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "./button";
import { MasterPasswordMeter } from "./master-password-meter";
import { Modal } from "./modal";
import { PasswordField } from "./password-field";

interface FilePasswordDialogProps {
	open: boolean;
	onClose: () => void;
	title: ReactNode;
	/** What the file is and what the password does. */
	description: ReactNode;
	/** Optional extra line, e.g. how many entries are going in. */
	detail?: ReactNode;
	submitLabel: ReactNode;
	busyLabel: ReactNode;
	/** Rejections surface as the field error; resolving closes the dialog. */
	onSubmit: (password: string) => Promise<void>;
}

/**
 * Collects a password that protects an exported file. Deliberately not the master password:
 * the file is meant to leave this device. Confirmed twice because nothing can recover it,
 * and metered because a weak one here is the whole file's only defence.
 */
export function FilePasswordDialog({
	open,
	onClose,
	title,
	description,
	detail,
	submitLabel,
	busyLabel,
	onSubmit,
}: FilePasswordDialogProps) {
	const { t } = useLingui();
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const close = () => {
		setPassword("");
		setConfirm("");
		setError(null);
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
			await onSubmit(password);
			close();
		} catch (err) {
			setError(err instanceof Error ? err.message : t`Couldn't write the file.`);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal open={open} onClose={close} className="max-w-md">
			<form onSubmit={submit} className="p-6 space-y-4">
				<div className="space-y-1.5">
					<h2 className="text-lg">{title}</h2>
					<p className="text-sm text-muted-foreground">{description}</p>
					{detail && <p className="text-sm text-muted-foreground">{detail}</p>}
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
								{busyLabel}
							</>
						) : (
							submitLabel
						)}
					</Button>
				</div>
			</form>
		</Modal>
	);
}
