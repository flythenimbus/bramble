import { Trans, useLingui } from "@lingui/react/macro";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useState } from "react";
import { usePlatform } from "../../../../context/PlatformContext";
import { bytesToBase64 } from "../../../../util/bytes";
import { Button } from "../../../components/ui/button";
import { PasswordField } from "../../../components/ui/password-field";
import { Header } from "./Header";
import { Shell } from "./Shell";

/**
 * Credential step for any import that is behind a password: a .kdbx and its optional key
 * file, or a .bramble sealed under a password chosen at export. The label and the key-file
 * field are per-format, since only KeePass has key files.
 */
export function KdbxUnlock({
	providerLabel,
	passwordLabel,
	allowKeyfile = true,
	onOpen,
	onBack,
}: {
	providerLabel: string;
	passwordLabel: string;
	/** KeePass only; a .bramble has no second factor. */
	allowKeyfile?: boolean;
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
					label={passwordLabel}
					autoFocus
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					error={error ?? undefined}
				/>
				{allowKeyfile && (
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
				)}
				<div className="flex items-center justify-between gap-3">
					<Button
						variant="secondary"
						size="none"
						onClick={onBack}
						disabled={busy}
						className="px-4 py-2 text-sm hover:bg-background/50"
					>
						<ArrowLeft className="w-3.5 h-3.5" />
						<Trans>Back</Trans>
					</Button>
					<Button
						type="submit"
						variant="primary"
						size="md"
						disabled={busy || (!password && !keyfile)}
					>
						{busy ? (
							<>
								<Loader2 className="w-3.5 h-3.5 animate-spin" />
								<Trans>Opening…</Trans>
							</>
						) : (
							t`Open database`
						)}
					</Button>
				</div>
			</form>
		</Shell>
	);
}
