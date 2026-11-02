import { Trans, useLingui } from "@lingui/react/macro";
import { useSearch } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { usePlatform } from "../../context/PlatformContext";
import { useVault } from "../../hooks/useVault";
import { Button } from "../components/ui/button";
import { PasswordField } from "../components/ui/password-field";

/**
 * Confirm it's you before a site uses one of your passkeys with the vault already unlocked: the
 * site requires user verification, or asked for its PRF key. The extension's passkey provider
 * opens this in a detached window and waits for the answer (docs/passkey-prf.md).
 */
export function PasskeyVerify({ id, rp }: { id: string; rp: string }) {
	const { hasPasswordSlot, verifyMasterPassword, verifyWithWebauthnKey } = useVault();
	const { shell } = usePlatform();
	const { t } = useLingui();
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const answer = async (verified: boolean) => {
		await shell.reportPasskeyVerification?.(id, verified);
		window.close();
	};

	const confirm = async (e?: React.SyntheticEvent) => {
		e?.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const ok = hasPasswordSlot
				? await verifyMasterPassword(password)
				: await verifyWithWebauthnKey();
			if (ok) await answer(true);
			else
				setError(
					hasPasswordSlot ? t`Incorrect master password` : t`Couldn't verify your key. Try again.`,
				);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<form className="flex-1 p-6 space-y-4" onSubmit={confirm}>
			<div className="flex items-center gap-3">
				<KeyRound className="w-5 h-5 text-primary" />
				<h1 className="text-base font-semibold">
					<Trans>Confirm it's you</Trans>
				</h1>
			</div>
			<p className="text-sm text-muted-foreground">
				<Trans>{rp} wants to use your passkey. Confirm it's you to continue.</Trans>
			</p>
			{hasPasswordSlot && (
				<PasswordField
					label={t`Master password`}
					autoFocus
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					disabled={busy}
				/>
			)}
			{error && <p className="text-xs text-destructive">{error}</p>}
			<div className="flex gap-2">
				<Button type="submit" variant="primary" disabled={busy || (hasPasswordSlot && !password)}>
					{hasPasswordSlot ? t`Confirm` : t`Use security key`}
				</Button>
				<Button variant="secondary" onClick={() => void answer(false)} disabled={busy}>
					<Trans>Cancel</Trans>
				</Button>
			</div>
		</form>
	);
}

/** The /passkey-verify route: the request id and site come from the window's URL. */
export function PasskeyVerifyRoute() {
	const { id, rp } = useSearch({ from: "/_app/passkey-verify" });
	return <PasskeyVerify id={id} rp={rp} />;
}
