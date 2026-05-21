import { useState } from "react";
import { useForm } from "react-hook-form";
import { FileLocationCard } from "./components/FileLocationCard";
import { ModeTabs } from "./components/ModeTabs";
import { PasswordCard } from "./components/PasswordCard";
import { SetupHeader } from "./components/SetupHeader";
import type { VaultSetupFormValues, VaultSetupMode } from "./types";

export type { VaultSetupMode } from "./types";

interface VaultSetupProps {
	hasPicker: boolean;
	hasFile: boolean;
	mode: VaultSetupMode;
	onModeChange: (mode: VaultSetupMode) => void;
	onChooseFile: () => Promise<void>;
	onCreate: (password: string) => Promise<void>;
	onUnlock: (password: string) => Promise<void>;
}

export function VaultSetup({
	hasPicker,
	hasFile,
	mode,
	onModeChange,
	onChooseFile,
	onCreate,
	onUnlock,
}: VaultSetupProps) {
	const [busy, setBusy] = useState(false);
	const [fileError, setFileError] = useState<string | null>(null);
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

	const handlePick = async () => {
		setFileError(null);
		setBusy(true);
		try {
			await onChooseFile();
		} catch (e) {
			setFileError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};

	const handleModeChange = (next: VaultSetupMode) => {
		if (next === mode) return;
		setFileError(null);
		setSubmitError(null);
		form.reset({ masterPassword: "", confirmPassword: "" });
		onModeChange(next);
	};

	return (
		<div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 flex items-center justify-center p-6">
			<div className="w-full max-w-xl">
				<SetupHeader mode={mode} />
				<ModeTabs mode={mode} onChange={handleModeChange} disabled={busy} />
				<FileLocationCard
					hasPicker={hasPicker}
					hasFile={hasFile}
					mode={mode}
					busy={busy}
					onPick={handlePick}
					error={fileError}
				/>
				<PasswordCard
					mode={mode}
					form={form}
					busy={busy}
					canSubmit={!hasPicker || hasFile}
					submitError={submitError}
					onSubmit={handleSubmit}
				/>
			</div>
		</div>
	);
}
