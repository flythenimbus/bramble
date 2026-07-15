import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { useForm } from "react-hook-form";
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
	/** Open a .bramble backup file instead of the on-device vault (extension restore flow).
	 * Shown only in "open" mode; absent where restore isn't supported (mobile). */
	onOpenFile?: () => void;
	/** Compact presentation for the single-window mobile host. */
	mobile?: boolean;
	/** Adding a parallel vault (vaults already exist): create-only, with a name field, and no
	 * "open existing / open file" paths (those are first-run concepts; open-file would overwrite
	 * a vault until the restore-destination chooser lands). See docs/multiple-vaults.md. */
	adding?: boolean;
}

/** Vault setup: pick create vs open, then set/enter the master password. The vault lives in
 * the platform's own storage, so there is no file-location step. */
export function VaultSetup({
	mode,
	onModeChange,
	onCreate,
	onUnlock,
	onOpenFile,
	mobile,
	adding,
}: VaultSetupProps) {
	const [busy, setBusy] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const form = useForm<VaultSetupFormValues>({
		defaultValues: { masterPassword: "", confirmPassword: "", label: "" },
	});
	// Adding a vault is always a create; the open/restore paths are hidden.
	const effectiveMode: VaultSetupMode = adding ? "create" : mode;

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

	return (
		<div className="min-h-screen bg-linear-to-br from-background via-background to-primary/5 flex items-center justify-center p-6">
			<div className="w-full max-w-xl">
				<SetupHeader mode={effectiveMode} mobile={mobile} adding={adding} />
				{!adding && (
					<ModeTabs mode={mode} onChange={handleModeChange} disabled={busy} pill={mobile} />
				)}
				<PasswordCard
					mode={effectiveMode}
					form={form}
					busy={busy}
					submitError={submitError}
					onSubmit={handleSubmit}
					mobile={mobile}
					showName={adding}
				/>
				{!adding && onOpenFile && (
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
