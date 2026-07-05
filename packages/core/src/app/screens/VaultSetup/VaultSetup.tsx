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
	onCreate: (password: string) => Promise<void>;
	onUnlock: (password: string) => Promise<void>;
	/** Compact presentation for the single-window mobile host. */
	mobile?: boolean;
}

/** Vault setup: pick create vs open, then set/enter the master password. The vault lives in
 * the platform's own storage, so there is no file-location step. */
export function VaultSetup({ mode, onModeChange, onCreate, onUnlock, mobile }: VaultSetupProps) {
	const [busy, setBusy] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const form = useForm<VaultSetupFormValues>({
		defaultValues: { masterPassword: "", confirmPassword: "" },
	});

	const handleSubmit = async ({ masterPassword }: VaultSetupFormValues) => {
		setSubmitError(null);
		setBusy(true);
		try {
			if (mode === "create") await onCreate(masterPassword);
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
		form.reset({ masterPassword: "", confirmPassword: "" });
		onModeChange(next);
	};

	return (
		<div className="min-h-screen bg-linear-to-br from-background via-background to-primary/5 flex items-center justify-center p-6">
			<div className="w-full max-w-xl">
				<SetupHeader mode={mode} mobile={mobile} />
				<ModeTabs mode={mode} onChange={handleModeChange} disabled={busy} pill={mobile} />
				<PasswordCard
					mode={mode}
					form={form}
					busy={busy}
					submitError={submitError}
					onSubmit={handleSubmit}
					mobile={mobile}
				/>
			</div>
		</div>
	);
}
