import { Trans, useLingui } from "@lingui/react/macro";
import { useSearch } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { usePlatform } from "../../context/PlatformContext";
import { useVault } from "../../hooks/useVault";
import { Button } from "../components/ui/button";
import { PasswordField } from "../components/ui/password-field";
import { useWebauthnUnlock } from "../hooks/useWebauthnUnlock";

/**
 * Confirm it's you before a site uses one of your passkeys with the vault already unlocked: the
 * site requires user verification, or asked for its PRF key. The extension's passkey provider
 * opens this in a detached window and waits for the answer (docs/passkey-prf.md).
 */
export function PasskeyVerify({ id, rp }: { id: string; rp: string }) {
	const { hasPasswordSlot, hasWebauthnSlot, verifyMasterPassword, verifyWithWebauthnKey } =
		useVault();
	const canTap = useWebauthnUnlock() && hasWebauthnSlot;
	const { shell } = usePlatform();
	const { t } = useLingui();
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState<"password" | "key" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [signInAgain, setSignInAgain] = useState(false);

	const answer = async (verified: boolean) => {
		const reply = await shell.reportPasskeyVerification?.(id, verified);
		if (reply?.signInAgain) setSignInAgain(true);
		else window.close();
	};

	const confirm = async (
		method: "password" | "key",
		check: () => Promise<boolean>,
		failure: string,
	) => {
		setBusy(method);
		setError(null);
		try {
			if (await check()) await answer(true);
			else setError(failure);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(null);
		}
	};

	const confirmWithPassword = (e: React.SyntheticEvent) => {
		e.preventDefault();
		void confirm("password", () => verifyMasterPassword(password), t`Incorrect master password`);
	};

	const confirmWithKey = () =>
		void confirm("key", verifyWithWebauthnKey, t`Couldn't verify your key. Try again.`);

	if (signInAgain) {
		return (
			<div className="flex-1 p-6 space-y-4">
				<p className="text-sm">
					<Trans>Confirmed. Sign in again on {rp}.</Trans>
				</p>
				<Button variant="primary" onClick={() => window.close()}>
					<Trans>Close</Trans>
				</Button>
			</div>
		);
	}

	return (
		<form className="flex-1 p-6 space-y-4" onSubmit={confirmWithPassword}>
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
					disabled={busy !== null}
				/>
			)}
			{error && <p className="text-xs text-destructive">{error}</p>}
			<div className="flex flex-wrap gap-2">
				{hasPasswordSlot && (
					<Button type="submit" variant="primary" disabled={busy !== null || !password}>
						<Trans>Confirm</Trans>
					</Button>
				)}
				{canTap && (
					<Button
						variant={hasPasswordSlot ? "secondary" : "primary"}
						onClick={confirmWithKey}
						disabled={busy !== null}
					>
						<KeyRound className="w-4 h-4" />
						{busy === "key" ? t`Waiting for your key…` : t`Tap to confirm`}
					</Button>
				)}
				<Button variant="secondary" onClick={() => void answer(false)} disabled={busy !== null}>
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
