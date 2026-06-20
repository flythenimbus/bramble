import { Check } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import type { OptionsScreen } from "../adapters/shell";
import { usePlatform } from "../context/PlatformContext";
import { useVault, VaultProvider } from "../hooks/useVault";
import { RecoveryCodeDisplay } from "./components/RecoveryCodeDisplay";
import { ThemeProvider } from "./hooks/useTheme";
import { VaultSetup, type VaultSetupMode } from "./screens/VaultSetup/VaultSetup";

// Lazy: the import pipeline + parsers load as an on-demand chunk, off the popup's main bundle.
const ImportShell = lazy(() =>
	import("./screens/Import/ImportShell").then((m) => ({ default: m.ImportShell })),
);

// `onComplete` lets a single-window host (mobile) return to its main UI instead of
// the "close this tab" terminal screen. When omitted (the extension's options tab),
// the terminal done screen is shown as before.
function SetupShell({ onComplete, mobile }: { onComplete?: () => void; mobile?: boolean }) {
	const { shell } = usePlatform();
	const { hasVault, pickVaultFile, createVault, unlock } = useVault();
	const [mode, setMode] = useState<VaultSetupMode>("create");
	const [hasFile, setHasFile] = useState(hasVault);
	const [done, setDone] = useState<null | "created" | "opened">(null);
	// One-time recovery code shown after creation; cleared on continue, never persisted in plaintext.
	const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
	const hasPicker = shell.hasFilePicker();

	if (recoveryCode) {
		return (
			<div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 flex items-center justify-center p-6">
				<div className="w-full max-w-xl rounded-xl border border-border bg-card/50 backdrop-blur-sm p-6">
					<RecoveryCodeDisplay
						code={recoveryCode}
						onContinue={() => {
							setRecoveryCode(null);
							if (onComplete) onComplete();
							else setDone("created");
						}}
					/>
				</div>
			</div>
		);
	}

	if (done) {
		return (
			<div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 flex items-center justify-center p-6">
				<div className="w-full max-w-xl text-center">
					<div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-primary/80 mb-4">
						<Check className="w-9 h-9 text-primary-foreground" />
					</div>
					<h1 className="text-2xl mb-2">{done === "created" ? "Vault ready" : "Vault unlocked"}</h1>
					<p className="text-sm text-muted-foreground">
						You can close this tab and use the {shell.appName} popup.
					</p>
				</div>
			</div>
		);
	}

	return (
		<VaultSetup
			mobile={mobile}
			hasPicker={hasPicker}
			hasFile={hasFile}
			mode={mode}
			onModeChange={(next) => {
				setMode(next);
				// Switching modes needs a re-pick (save-dialog for new vs open-dialog for existing).
				setHasFile(false);
			}}
			onChooseFile={async () => {
				await pickVaultFile(mode);
				setHasFile(true);
			}}
			onCreate={async (password) => {
				// createVault returns the one-time recovery code to display first.
				setRecoveryCode(await createVault(password));
			}}
			onUnlock={async (password) => {
				await unlock(password);
				if (onComplete) onComplete();
				else setDone("opened");
			}}
		/>
	);
}

export default function OptionsApp({
	onComplete,
	mobile,
	screen,
}: {
	onComplete?: () => void;
	mobile?: boolean;
	/** Force a screen (single-window hosts pass this); otherwise read from `?screen=`. */
	screen?: OptionsScreen;
} = {}) {
	// `?screen=import` (from Settings) routes to the import flow instead of setup.
	const active = screen ?? new URLSearchParams(window.location.search).get("screen");
	return (
		<ThemeProvider>
			<VaultProvider>
				{active === "import" ? (
					<Suspense fallback={null}>
						<ImportShell onClose={onComplete} />
					</Suspense>
				) : (
					<SetupShell onComplete={onComplete} mobile={mobile} />
				)}
			</VaultProvider>
		</ThemeProvider>
	);
}
