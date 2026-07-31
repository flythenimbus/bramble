import { Trans } from "@lingui/react/macro";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { BrambleGlyph } from "../../components/BrambleGlyph";
import { BackButton } from "../../components/ui/back-button";
import { RestoreShell } from "../Restore/RestoreShell";
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
	/** Create a new vault by pairing to another device with its invite code (both first-run and
	 * adding). Resolves when the join completes; the parent drives the terminal screen. Absent
	 * (no join tab) where per-vault sync isn't supported (mobile, for now). */
	onJoin?: (pairingCode: string, password: string) => Promise<void>;
	/** A setup-flow join is running (new vault created, pairing into it): show the connecting state. */
	joining?: boolean;
	/** The last join failure, surfaced in the join form. */
	joinError?: string | null;
	/** The pairing SAS, once the channel is authenticated: the user compares it against the same
	 * number on the inviting device before approving there. Absent until then. */
	joinSas?: string | null;
	/** Restore a .bramble backup (the "Restore from backup" tab; rendered inline like the others).
	 * Called on success so the parent drives the terminal screen; `addedNew` marks a restored-into-new
	 * locked vault vs the first vault unlocked in place. Absent where restore isn't supported (mobile). */
	onRestore?: (result: { addedNew: boolean }) => void;
	/** Compact presentation for the single-window mobile host. */
	mobile?: boolean;
	/** Adding a parallel vault (vaults already exist): shows a name field and the "Add a vault"
	 * heading. Create/restore/join are offered the same way as first-run. See docs/multiple-vaults.md. */
	adding?: boolean;
	/** Dismiss the setup shell and return to the main app. Shown as a top-left back button. Absent
	 * on first run (0 vaults) - there's nowhere to go back to yet. Single-window mobile only. */
	onBack?: () => void;
}

/** Vault setup: pick create / restore / join, then set the master password (or restore a .bramble
 * backup / paste a pairing code). The vault lives in the platform's own storage, no file-location step. */
export function VaultSetup({
	mode,
	onModeChange,
	onCreate,
	onJoin,
	joining,
	joinError,
	joinSas,
	onRestore,
	mobile,
	adding,
	onBack,
}: VaultSetupProps) {
	const [busy, setBusy] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const form = useForm<VaultSetupFormValues>({
		defaultValues: { masterPassword: "", confirmPassword: "", label: "" },
	});
	// Fall a tab back to create when its panel isn't available (no join / no restore on this host).
	const effectiveMode: VaultSetupMode =
		(mode === "join" && !onJoin) || (mode === "restore" && !onRestore) ? "create" : mode;

	const handleCreate = async ({ masterPassword, label }: VaultSetupFormValues) => {
		setSubmitError(null);
		setBusy(true);
		try {
			await onCreate(masterPassword, label);
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
						{joinSas ? (
							<Trans>Check this matches</Trans>
						) : (
							<Trans>Connecting to your other device…</Trans>
						)}
					</h1>
					{joinSas ? (
						<>
							{/* The comparison is the whole defence, so the number is the loudest thing on
							    screen and the instruction is one sentence. */}
							<p className={`text-muted-foreground ${mobile ? "text-base" : "text-sm"}`}>
								<Trans>
									Your other device is showing a number. Confirm it there only if it matches this
									one.
								</Trans>
							</p>
							<p className="mt-6 font-mono text-3xl tracking-[0.2em] tabular-nums">{joinSas}</p>
							<p className="mt-4 text-xs text-muted-foreground">
								<Trans>
									If the numbers differ, someone else is trying to join. Reject it there and start
									again with a new code.
								</Trans>
							</p>
							{/* Backgrounding here isn't survivable: the OS suspends the app and the connection
							    dies with it. Cheaper to warn than to explain the failure afterwards. */}
							<p className="mt-2 text-xs text-muted-foreground">
								<Trans>Keep this screen open until pairing finishes.</Trans>
							</p>
						</>
					) : (
						<p className={`text-muted-foreground ${mobile ? "text-base" : "text-sm"}`}>
							<Trans>Keep the invite open on your other device while the vault transfers.</Trans>
						</p>
					)}
					<Loader2 className="w-6 h-6 mt-6 inline-block animate-spin text-primary" />
				</div>
			</div>
		);
	}

	return (
		<div className="min-h-screen bg-linear-to-br from-background via-background to-primary/5 flex items-start justify-center p-6">
			<div className="w-full max-w-xl">
				{onBack && <BackButton onClick={onBack} className="mb-3" />}
				<SetupHeader mode={effectiveMode} mobile={mobile} adding={adding} />
				<ModeTabs
					mode={effectiveMode}
					onChange={handleModeChange}
					disabled={busy}
					showRestore={!!onRestore}
					showJoin={!!onJoin}
				/>
				{effectiveMode === "restore" && onRestore ? (
					<RestoreShell embedded onRestored={onRestore} />
				) : effectiveMode === "join" && onJoin ? (
					<JoinCard onJoin={onJoin} busy={!!joining} error={joinError ?? null} mobile={mobile} />
				) : (
					<PasswordCard
						form={form}
						busy={busy}
						submitError={submitError}
						onSubmit={handleCreate}
						mobile={mobile}
						showName={adding}
					/>
				)}
			</div>
		</div>
	);
}
