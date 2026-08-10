import { Trans, useLingui } from "@lingui/react/macro";
import { Check, Copy, RefreshCw } from "lucide-react";
import { useState } from "react";
import { usePlatform } from "../../../../context/PlatformContext";
import { useFlag } from "../../../../hooks/useFlag";
import { useVault } from "../../../../hooks/useVault";
import { Button } from "../../../components/ui/button";
import { PasswordField } from "../../../components/ui/password-field";
import { Section } from "./primitives";

/**
 * Re-encrypt the vault under a fresh key.
 *
 * Shaped like Delete vault because it is in the same class: something a few people genuinely need
 * and nobody should reach by accident. So it is destructive-styled, it states every consequence
 * before asking for the password, and it suggests a backup first.
 *
 * All of the crypto lives in useVault.rotateSecret, which does it in one write and rolls back on
 * failure. This collects the password and shows the new recovery code once.
 */
export function RotateSecretSection() {
	const { hasPasswordSlot, rotateSecret } = useVault();
	// Through the hook, not a direct flags import: the dev panel can flip this at runtime and a
	// captured value would leave the section hidden after the box was ticked.
	const enabled = useFlag("rotateVaultSecret");
	const { clipboard } = usePlatform();
	const { t } = useLingui();
	const [confirming, setConfirming] = useState(false);
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [freshCode, setFreshCode] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);

	// Off by default. The operation is tested, but it ends with every other device unable to read
	// the vault and a recovery code the user has to save right then, so it stays behind the flag
	// until it has been exercised on real vaults. See flags.json.
	if (!enabled) return null;
	// Nothing to rotate with: rotation re-wraps the password slot, so the password is the one
	// credential that has to survive it.
	if (!hasPasswordSlot) return null;

	const rotate = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		setBusy(true);
		try {
			setFreshCode(await rotateSecret(password));
			setPassword("");
			setConfirming(false);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	};

	// The new code is shown once and never again, so it stays on screen until dismissed rather
	// than clearing on the next render or a click elsewhere.
	if (freshCode) {
		return (
			<Section icon={<RefreshCw className="w-4 h-4 text-primary" />} title={t`Rotate secret`}>
				<div className="space-y-3">
					<p className="text-xs text-muted-foreground">
						<Trans>
							Done. Your old recovery code no longer works. Save this one now: it is shown only
							here, and it is the only way back in if you forget your master password.
						</Trans>
					</p>
					<p className="px-3 py-2 rounded-lg border border-border font-mono text-sm break-all">
						{freshCode}
					</p>
					<div className="flex items-center gap-2">
						<Button
							variant="secondary"
							size="sm"
							onClick={() => {
								void clipboard.copy(freshCode);
								setCopied(true);
							}}
						>
							{copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
							{copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
						</Button>
						<Button variant="ghost" size="sm" onClick={() => setFreshCode(null)}>
							<Trans>I've saved it</Trans>
						</Button>
					</div>
					<p className="text-xs text-muted-foreground">
						<Trans>
							Your other devices can no longer read this vault. Pair each of them again from Device
							sync.
						</Trans>
					</p>
				</div>
			</Section>
		);
	}

	return (
		<Section icon={<RefreshCw className="w-4 h-4 text-destructive" />} title={t`Rotate secret`}>
			{!confirming ? (
				<div className="space-y-3">
					<p className="text-xs text-muted-foreground">
						<Trans>
							Replaces the key everything in this vault is encrypted with. Worth doing if you
							believe a copy of the vault file has been exposed, since anything taken before cannot
							be opened with the new key.
						</Trans>
					</p>
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
						<RefreshCw className="w-4 h-4" />
						<Trans>Rotate this vault's secret</Trans>
					</Button>
				</div>
			) : (
				<div className="space-y-3">
					{/* Every consequence, before the password field. Two of these lock people out of
					    things if they are not read: a recovery code they think still works, and
					    devices they assume will catch up on their own. */}
					<p className="text-xs text-muted-foreground">
						<Trans>Before you continue, three things change and none of them can be undone:</Trans>
					</p>
					<ul className="text-xs text-muted-foreground space-y-1.5 list-disc pl-5">
						<li>
							<Trans>
								Your other devices stop being able to read this vault. They all share the key being
								replaced, so each one has to be paired again from Device sync.
							</Trans>
						</li>
						<li>
							<Trans>
								Your recovery code stops working. A new one is shown once, right after, and you will
								need to save it.
							</Trans>
						</li>
						<li>
							<Trans>
								Security keys are removed from this vault and have to be added again. Your master
								password keeps working.
							</Trans>
						</li>
					</ul>
					<p className="text-xs text-muted-foreground">
						<Trans>Take a backup first, from Backups, so you have a copy that still opens.</Trans>
					</p>
					<form onSubmit={rotate} className="space-y-3">
						<PasswordField
							label={t`Master password`}
							autoFocus
							value={password}
							onChange={(e) => {
								setPassword(e.target.value);
								setError(null);
							}}
						/>
						{error && <p className="text-xs text-destructive">{error}</p>}
						<div className="flex justify-end gap-2">
							<Button
								variant="secondary"
								size="sm"
								onClick={() => {
									setConfirming(false);
									setPassword("");
								}}
							>
								<Trans>Cancel</Trans>
							</Button>
							<Button variant="destructive" size="sm" type="submit" disabled={busy || !password}>
								{busy ? <Trans>Rotating…</Trans> : <Trans>Rotate secret</Trans>}
							</Button>
						</div>
					</form>
				</div>
			)}
		</Section>
	);
}
