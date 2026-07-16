import { Trans } from "@lingui/react/macro";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { BrambleGlyph } from "../../components/BrambleGlyph";
import { JoinCard } from "./components/JoinCard";
import { ModeTabs } from "./components/ModeTabs";
import { PasswordCard } from "./components/PasswordCard";
import { SetupHeader } from "./components/SetupHeader";
import type { VaultSetupFormValues, VaultSetupMode } from "./types";

export type { VaultSetupMode } from "./types";

interface VaultSetupProps {
	mode: VaultSetupMode;
	onModeChange: (mode: VaultSetupMode) => void;
	onCreate: (password: string, label: string) => Promise<void>;
	onUnlock: (password: string) => Promise<void>;
	/** Create a new vault by pairing to another device with its invite code (both first-run and
	 * adding). Resolves when the join completes; the parent drives the terminal screen. Absent
	 * (no join tab) where per-vault sync isn't supported (mobile, for now). */
	onJoin?: (pairingCode: string, password: string) => Promise<void>;
	/** A setup-flow join is running (new vault created, pairing into it): show the connecting state. */
	joining?: boolean;
	/** The last join failure, surfaced in the join form. */
	joinError?: string | null;
	/** Open a .bramble backup file instead of the on-device vault (extension restore flow).
	 * Shown only in "open" mode; absent where restore isn't supported (mobile). */
	onOpenFile?: () => void;
	/** Compact presentation for the single-window mobile host. */
	mobile?: boolean;
	/** Adding a parallel vault (vaults already exist): create or join, with a name field, and no
	 * "open existing" path (that is a first-run concept). See docs/multiple-vaults.md. */
	adding?: boolean;
}

/** Vault setup: pick create / open / join, then set/enter the master password (or paste a pairing
 * code). The vault lives in the platform's own storage, so there is no file-location step. */
export function VaultSetup({
	mode,
	onModeChange,
	onCreate,
	onUnlock,
	onJoin,
	joining,
	joinError,
	onOpenFile,
	mobile,
	adding,
}: VaultSetupProps) {
	const [busy, setBusy] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const form = useForm<VaultSetupFormValues>({
		defaultValues: { masterPassword: "", confirmPassword: "", label: "" },
	});
	// Adding a vault can't "open existing" (that is a first-run path), but it can create or join.
	// If join isn't available (no onJoin), fall a stray join mode back to create.
	const effectiveMode: VaultSetupMode =
		(adding && mode === "open") || (mode === "join" && !onJoin) ? "create" : mode;

	const handleSubmit = async ({ masterPassword, label }: VaultSetupFormValues) => {
		setSubmitError(null);
		setBusy(true);
		try {
			if (effectiveMode === "create") await onCreate(masterPassword, label);
			else await onUnlock(masterPassword);
		} catch (e) {
			setSubmitError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};

	const handleModeChange = (next: VaultSetupMode) => {
		if (next === mode) return;
		setSubmitError(null);
		form.reset({ masterPassword: "", confirmPassword: "", label: "" });
		onModeChange(next);
	};

	// While the join runs (a new empty vault is briefly active, which would otherwise flip the
	// tabs), show a dedicated connecting state instead of the setup form.
	if (joining) {
		return (
			<div className="min-h-screen bg-linear-to-br from-background via-background to-primary/5 flex items-center justify-center p-6">
				<div className="w-full max-w-xl text-center">
					<BrambleGlyph className="w-16 h-16 text-foreground mb-4 inline-block" />
					<h1 className="text-2xl mb-2">
						<Trans>Connecting to your other device…</Trans>
					</h1>
					<p className={`text-muted-foreground ${mobile ? "text-base" : "text-sm"}`}>
						<Trans>Keep the invite open on your other device while the vault transfers.</Trans>
					</p>
					<Loader2 className="w-6 h-6 mt-6 inline-block animate-spin text-primary" />
				</div>
			</div>
		);
	}

	return (
		<div className="min-h-screen bg-linear-to-br from-background via-background to-primary/5 flex items-center justify-center p-6">
			<div className="w-full max-w-xl">
				<SetupHeader mode={effectiveMode} mobile={mobile} adding={adding} />
				<ModeTabs
					mode={effectiveMode}
					onChange={handleModeChange}
					disabled={busy}
					pill={mobile}
					showOpen={!adding}
					showJoin={!!onJoin}
					onRestore={adding && onOpenFile ? onOpenFile : undefined}
				/>
				{effectiveMode === "join" && onJoin ? (
					<JoinCard onJoin={onJoin} busy={!!joining} error={joinError ?? null} mobile={mobile} />
				) : (
					<PasswordCard
						mode={effectiveMode}
						form={form}
						busy={busy}
						submitError={submitError}
						onSubmit={handleSubmit}
						mobile={mobile}
						showName={adding}
					/>
				)}
				{!adding && effectiveMode !== "join" && onOpenFile && (
					<button
						type="button"
						onClick={onOpenFile}
						disabled={busy}
						className="mt-3 w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
					>
						{effectiveMode === "create" ? (
							<Trans>Have a backup? Open a .bramble file instead</Trans>
						) : (
							<Trans>Open a backup file instead</Trans>
						)}
					</button>
				)}
			</div>
		</div>
	);
}
