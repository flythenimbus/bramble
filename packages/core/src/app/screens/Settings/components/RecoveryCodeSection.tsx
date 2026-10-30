import { Trans, useLingui } from "@lingui/react/macro";
import { LifeBuoy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useVault } from "../../../../hooks/useVault";
import { RecoveryCodeDisplay } from "../../../components/RecoveryCodeDisplay";
import { Button } from "../../../components/ui/button";
import { Modal } from "../../../components/ui/modal";
import { PasswordField } from "../../../components/ui/password-field";
import { cn } from "../../../components/ui/utils";
import { useSettingsHighlight } from "../settings-search";
import { Row } from "./primitives";

/** Settings row to generate or reset the vault's one-time recovery code. */
export function RecoveryCodeSection() {
	const {
		hasPasswordSlot,
		hasRecoveryCode,
		verifyMasterPassword,
		verifyWithWebauthnKey,
		generateRecoveryCode,
	} = useVault();
	const { t } = useLingui();
	const [gating, setGating] = useState(false); // showing the password-confirm input
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [freshCode, setFreshCode] = useState<string | null>(null);
	// Highlighted after a password reset done with the recovery code: a suggestion, not a gate.
	const [highlight, setHighlight] = useSettingsHighlight();
	const highlighted = highlight === "recovery-code";
	const highlightRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (highlighted) highlightRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
	}, [highlighted]);

	const rotate = async () => {
		setFreshCode(await generateRecoveryCode());
		if (highlighted) setHighlight(undefined);
	};

	// Requires authorization: a master-password confirm if one is set, else a security-key tap.
	const begin = async () => {
		setError(null);
		if (hasPasswordSlot) {
			setPassword("");
			setGating(true);
			return;
		}
		setBusy(true);
		try {
			const ok = await verifyWithWebauthnKey();
			if (!ok) {
				setError(t`Couldn't verify your key. Try again.`);
				return;
			}
			await rotate();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};

	const confirmWithPassword = async (e: React.SyntheticEvent) => {
		e.preventDefault();
		setError(null);
		setBusy(true);
		try {
			const ok = await verifyMasterPassword(password);
			if (!ok) {
				setError(t`Incorrect master password`);
				return;
			}
			await rotate();
			setGating(false);
			setPassword("");
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div
			ref={highlightRef}
			className={cn(
				"space-y-4",
				highlighted && "rounded-lg border border-primary/40 bg-primary/5 p-3",
			)}
		>
			{highlighted && (
				<p className="text-xs text-primary">
					<Trans>
						You used your recovery code. You can reset it now so the old one stops working.
					</Trans>
				</p>
			)}
			<Row
				icon={<LifeBuoy className="w-4 h-4 text-primary" />}
				title={t`Recovery code`}
				subtitle={
					hasRecoveryCode
						? t`A one-time backup code that unlocks your vault if you're locked out.`
						: t`No recovery code yet. Generate one as a backup way in.`
				}
			>
				{!gating && (
					<Button variant="secondary" size="sm" onClick={() => void begin()} disabled={busy}>
						{busy && !hasPasswordSlot ? t`Tap your key…` : hasRecoveryCode ? t`Reset` : t`Generate`}
					</Button>
				)}
			</Row>

			{hasRecoveryCode && !gating && (
				<p className="text-xs text-muted-foreground pl-12">
					<Trans>Resetting invalidates your old code.</Trans>
				</p>
			)}

			{gating && (
				<form className="ml-12 mt-2 space-y-2" onSubmit={confirmWithPassword}>
					<p className="text-xs text-muted-foreground">
						{hasRecoveryCode ? (
							<Trans>Confirm your master password to reset the recovery code.</Trans>
						) : (
							<Trans>Confirm your master password to generate the recovery code.</Trans>
						)}
					</p>
					<PasswordField
						label={t`Master password`}
						autoFocus
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						disabled={busy}
					/>
					<div className="flex gap-2">
						<Button type="submit" variant="primary" size="sm" disabled={busy || !password}>
							{busy ? t`Working…` : t`Confirm`}
						</Button>
						<Button
							variant="secondary"
							size="sm"
							onClick={() => {
								setGating(false);
								setPassword("");
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

			<Modal
				open={freshCode !== null}
				onClose={() => setFreshCode(null)}
				dismissable={false}
				className="max-w-lg"
			>
				<div className="p-6">
					{freshCode && (
						<RecoveryCodeDisplay
							code={freshCode}
							title={t`Your new recovery code`}
							continueLabel={t`Done`}
							onContinue={() => setFreshCode(null)}
						/>
					)}
				</div>
			</Modal>
		</div>
	);
}
