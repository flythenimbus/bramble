import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { Button } from "../../../components/ui/button";
import { PasswordField } from "../../../components/ui/password-field";
import { Header } from "./Header";
import { Shell } from "./Shell";

export function UnlockGate({ onUnlock }: { onUnlock: (pw: string) => Promise<void> }) {
	const { t } = useLingui();
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async (e: React.SyntheticEvent) => {
		e.preventDefault();
		setError(null);
		setBusy(true);
		try {
			await onUnlock(password);
		} catch (err) {
			setError(err instanceof Error ? err.message : t`Couldn't unlock the vault.`);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Shell>
			<Header subtitle={t`Unlock your vault to import into it`} />
			<form
				onSubmit={submit}
				className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm p-6 space-y-4"
			>
				<PasswordField
					label={t`Master password`}
					autoFocus
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					error={error ?? undefined}
				/>
				<Button
					type="submit"
					variant="primary"
					size="none"
					fullWidth
					disabled={busy || !password}
					className="px-5 py-2.5 text-sm"
				>
					{busy ? t`Unlocking…` : t`Unlock`}
				</Button>
			</form>
		</Shell>
	);
}
