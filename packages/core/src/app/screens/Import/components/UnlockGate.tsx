import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { TextField } from "../../../components/ui/text-field";
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
				<TextField
					label={t`Master password`}
					type="password"
					autoComplete="current-password"
					autoFocus
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					error={error ?? undefined}
				/>
				<button
					type="submit"
					disabled={busy || !password}
					className="w-full px-5 py-2.5 text-sm rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 active:scale-[0.98] transition-all disabled:opacity-50"
				>
					{busy ? t`Unlocking…` : t`Unlock`}
				</button>
			</form>
		</Shell>
	);
}
