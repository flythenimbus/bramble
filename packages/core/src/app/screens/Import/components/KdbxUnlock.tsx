import { Trans, useLingui } from "@lingui/react/macro";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useState } from "react";
import { usePlatform } from "../../../../context/PlatformContext";
import { bytesToBase64 } from "../../../../util/bytes";
import { PasswordField } from "../../../components/ui/password-field";
import { Header } from "./Header";
import { Shell } from "./Shell";

/** Credential step for an encrypted .kdbx: its own master password plus an optional key file. */
export function KdbxUnlock({
	providerLabel,
	onOpen,
	onBack,
}: {
	providerLabel: string;
	onOpen: (password: string, keyfileB64?: string) => Promise<void>;
	onBack: () => void;
}) {
	const { t } = useLingui();
	const { shell } = usePlatform();
	const [password, setPassword] = useState("");
	const [keyfile, setKeyfile] = useState<File | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async (e: React.SyntheticEvent) => {
		e.preventDefault();
		setError(null);
		setBusy(true);
		try {
			const keyfileB64 = keyfile
				? bytesToBase64(new Uint8Array(await keyfile.arrayBuffer()))
				: undefined;
			await onOpen(password, keyfileB64);
		} catch (err) {
			setError(err instanceof Error ? err.message : t`Couldn't open this database.`);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Shell>
			<Header subtitle={t`Enter the password for your ${providerLabel} database`} />
			<form
				onSubmit={submit}
				className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm p-6 space-y-4"
			>
				<PasswordField
					label={t`KeePass master password`}
					autoFocus
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					error={error ?? undefined}
				/>
				<label className="flex flex-col gap-3">
					<span className="text-sm">
						<Trans>Key file (optional)</Trans>
					</span>
					<input
						type="file"
						// Keep the vault unlocked while the OS picker backgrounds the app (mobile).
						onClick={() => shell.notifyFilePickerOpening?.()}
						onChange={(e) => setKeyfile(e.currentTarget.files?.[0] ?? null)}
						className="block w-full text-xs text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-background/50 file:px-3 file:py-1.5 file:text-sm hover:file:bg-background/80"
					/>
				</label>
				<div className="flex items-center justify-between gap-3">
					<button
						type="button"
						onClick={onBack}
						disabled={busy}
						className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg border border-border hover:bg-background/50 active:scale-[0.98] transition-all disabled:opacity-50"
					>
						<ArrowLeft className="w-3.5 h-3.5" />
						<Trans>Back</Trans>
					</button>
					<button
						type="submit"
						disabled={busy || (!password && !keyfile)}
						className="flex items-center gap-2 px-5 py-2 text-sm rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 active:scale-[0.98] transition-all disabled:opacity-50"
					>
						{busy ? (
							<>
								<Loader2 className="w-3.5 h-3.5 animate-spin" />
								<Trans>Opening…</Trans>
							</>
						) : (
							t`Open database`
						)}
					</button>
				</div>
			</form>
		</Shell>
	);
}
