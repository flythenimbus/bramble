import { Trans, useLingui } from "@lingui/react/macro";
import { Check, QrCode, Users } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useCan, usePlatform } from "../../../../context/PlatformContext";
import { Button } from "../../../components/ui/button";
import { PasswordField } from "../../../components/ui/password-field";

interface JoinCardProps {
	/** Create a new vault by joining the group behind this pairing code, using the shared master
	 * password. Rejects on a bad code / password mismatch (surfaced inline). */
	onJoin: (pairingCode: string, password: string) => Promise<void>;
	busy: boolean;
	/** A join failure reported by the async join effect (password mismatch, transfer error). */
	error: string | null;
	mobile?: boolean;
}

/** Pairing-code + master-password form: creates a NEW vault on this device by pairing to an
 * existing one and syncing its vault over. See docs/multiple-vaults.md. */
export function JoinCard({ onJoin, busy, error, mobile }: JoinCardProps) {
	const { t } = useLingui();
	const { shell } = usePlatform();
	// Camera scan of the pairing QR (mobile only; extension pastes).
	const canScan = useCan("cameraScan");
	const [code, setCode] = useState("");
	const [password, setPassword] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [scanning, setScanning] = useState(false);
	// Scan-first on mobile, paste-only on the extension (no camera).
	const [showPaste, setShowPaste] = useState(!canScan);

	const scan = async () => {
		setLocalError(null);
		setScanning(true);
		try {
			const scanned = await shell.scanQrFromActiveTab();
			if (scanned) setCode(scanned);
			else setLocalError(t`No QR code detected. Try again, or paste the code.`);
		} catch (err) {
			setLocalError((err as Error).message);
		} finally {
			setScanning(false);
		}
	};

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setLocalError(null);
		if (!code.trim()) {
			setLocalError(t`Paste the pairing code from your other device.`);
			return;
		}
		if (!password) {
			setLocalError(t`Enter the master password shared with your other device.`);
			return;
		}
		setSubmitting(true);
		try {
			await onJoin(code.trim(), password);
		} catch (err) {
			setLocalError((err as Error).message);
		} finally {
			setSubmitting(false);
		}
	};

	const disabled = busy || submitting || scanning;
	const shownError = error ?? localError;

	return (
		<form onSubmit={submit}>
			<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
				<div className="px-5 py-3 border-b border-border/50">
					<h3 className={`flex items-center gap-2 ${mobile ? "text-base" : "text-sm"}`}>
						<Users className="w-4 h-4 text-primary" />
						<Trans>Pair with another device</Trans>
					</h3>
				</div>
				<div className="p-5 space-y-4">
					<div>
						{canScan && !showPaste ? (
							<>
								<Button
									variant="secondary"
									size="none"
									fullWidth
									onClick={() => void scan()}
									disabled={disabled}
									className="flex flex-col gap-1.5 border-2 border-dashed px-4 py-6"
								>
									{code ? (
										<Check className="w-7 h-7 text-emerald-500" />
									) : (
										<QrCode className="w-7 h-7 text-primary" />
									)}
									<span className="text-sm font-medium">
										{scanning ? (
											<Trans>Scanning…</Trans>
										) : code ? (
											<Trans>Code scanned</Trans>
										) : (
											<Trans>Scan QR code</Trans>
										)}
									</span>
									<span className="text-xs text-muted-foreground">
										{code ? (
											<Trans>Tap to scan again</Trans>
										) : (
											<Trans>Point your camera at the code on your other device</Trans>
										)}
									</span>
								</Button>
								<Button
									variant="link"
									size="none"
									fullWidth
									onClick={() => setShowPaste(true)}
									className="mt-2 text-xs"
								>
									<Trans>Paste code instead</Trans>
								</Button>
							</>
						) : (
							<>
								<label htmlFor="pairing-code" className="block text-sm mb-1.5">
									<Trans>Pairing code</Trans>
								</label>
								<textarea
									id="pairing-code"
									value={code}
									onChange={(e) => setCode(e.target.value)}
									placeholder={t`Paste the code from your other device's "Add a device" screen`}
									rows={3}
									autoComplete="off"
									spellCheck={false}
									className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-transparent font-mono break-all resize-none focus:outline-none focus:border-primary/50"
								/>
								{canScan && (
									<Button
										variant="link"
										size="none"
										fullWidth
										onClick={() => setShowPaste(false)}
										className="mt-2 gap-1.5 text-xs"
									>
										<QrCode className="w-3.5 h-3.5" /> <Trans>Scan QR code instead</Trans>
									</Button>
								)}
							</>
						)}
					</div>
					<PasswordField
						label={t`Master password`}
						value={password}
						onChange={(e) => setPassword(e.target.value)}
					/>
					<div className="rounded-md p-3 bg-muted/40 border border-border/50 text-xs text-muted-foreground">
						<Trans>
							This creates a new vault on this device and syncs it from your other device. Use the
							same master password as that device.
						</Trans>
					</div>
				</div>
				<div
					className={`px-5 py-4 bg-muted/30 border-t border-border/50 flex gap-3 ${
						mobile ? "flex-col items-stretch" : "items-center justify-end"
					}`}
				>
					{shownError && (
						<p
							className={`text-destructive ${mobile ? "text-sm" : "flex-1 text-xs truncate"}`}
							title={shownError}
						>
							{shownError}
						</p>
					)}
					<Button
						type="submit"
						variant="primary"
						size={mobile ? "lg" : "md"}
						fullWidth={mobile}
						disabled={disabled}
					>
						{disabled ? <Trans>Connecting…</Trans> : <Trans>Join vault</Trans>}
					</Button>
				</div>
			</div>
		</form>
	);
}
