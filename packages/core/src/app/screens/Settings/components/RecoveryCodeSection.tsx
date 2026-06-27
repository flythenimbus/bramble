import { Trans, useLingui } from "@lingui/react/macro";
import { LifeBuoy } from "lucide-react";
import { useState } from "react";
import { useVault } from "../../../../hooks/useVault";
import { RecoveryCodeDisplay } from "../../../components/RecoveryCodeDisplay";
import { Modal } from "../../../components/ui/modal";
import { Row } from "./primitives";

/** Settings row to generate or reset the vault's one-time recovery code. */
export function RecoveryCodeSection() {
	const {
		hasPasswordSlot,
		hasRecoveryCode,
		verifyMasterPassword,
		verifyWithSecurityKey,
		generateRecoveryCode,
	} = useVault();
	const { t } = useLingui();
	const [gating, setGating] = useState(false); // showing the password-confirm input
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [freshCode, setFreshCode] = useState<string | null>(null);

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
			const ok = await verifyWithSecurityKey();
			if (!ok) {
				setError(t`Couldn't verify your security key. Try again.`);
				return;
			}
			setFreshCode(await generateRecoveryCode());
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
			setFreshCode(await generateRecoveryCode());
			setGating(false);
			setPassword("");
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
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
					<button
						type="button"
						onClick={() => void begin()}
						disabled={busy}
						className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98] transition-all disabled:opacity-50"
					>
						{busy && !hasPasswordSlot ? t`Tap your key…` : hasRecoveryCode ? t`Reset` : t`Generate`}
					</button>
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
					<input
						type="password"
						autoFocus
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						placeholder={t`Master password`}
						disabled={busy}
						className="w-full px-3 py-1.5 text-xs rounded-lg border border-border bg-transparent focus:outline-none focus:border-primary/50"
					/>
					<div className="flex gap-2">
						<button
							type="submit"
							disabled={busy || !password}
							className="px-3 py-1.5 text-xs rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 disabled:opacity-50"
						>
							{busy ? t`Working…` : t`Confirm`}
						</button>
						<button
							type="button"
							onClick={() => {
								setGating(false);
								setPassword("");
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
		</>
	);
}
