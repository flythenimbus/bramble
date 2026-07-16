import { Trans } from "@lingui/react/macro";
import { Check } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import type { OptionsScreen } from "../adapters/shell";
import { useCan, usePlatform } from "../context/PlatformContext";
import { useVault, VaultProvider } from "../hooks/useVault";
import { useVaultRegistry, VaultRegistryProvider } from "../hooks/useVaultRegistry";
import { RecoveryCodeDisplay } from "./components/RecoveryCodeDisplay";
import { ErrorBoundary } from "./ErrorBoundary";
import { ThemeProvider } from "./hooks/useTheme";
import { LocaleGate } from "./LocaleGate";
import { VaultSetup, type VaultSetupMode } from "./screens/VaultSetup/VaultSetup";

// Lazy: the import pipeline + parsers load as an on-demand chunk, off the popup's main bundle.
const ImportShell = lazy(() =>
	import("./screens/Import/ImportShell").then((m) => ({ default: m.ImportShell })),
);
const RestoreShell = lazy(() =>
	import("./screens/Restore/RestoreShell").then((m) => ({ default: m.RestoreShell })),
);

// `onComplete` lets a single-window host (mobile) return to its main UI instead of
// the "close this tab" terminal screen. When omitted (the extension's options tab),
// the terminal done screen is shown as before.
function SetupShell({ onComplete, mobile }: { onComplete?: () => void; mobile?: boolean }) {
	const { shell } = usePlatform();
	const canRestore = useCan("restore");
	// Join-a-device (add a vault by pairing) rides per-vault sync; hidden where that's unsupported.
	const canJoin = useCan("perVaultSync");
	const { createVault, unlock, startJoin, joining, joinError } = useVault();
	// Adding a parallel vault when one already exists: create-only, named, no open/restore paths.
	const { vaults } = useVaultRegistry();
	const adding = vaults.length > 0;
	const [mode, setMode] = useState<VaultSetupMode>("create");
	const [done, setDone] = useState<null | "created" | "opened">(null);
	// One-time recovery code shown after creation; cleared on continue, never persisted in plaintext.
	const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
	// "Open existing vault" -> open a .bramble file: reuse the restore flow (extension only).
	const [openingFile, setOpeningFile] = useState(false);

	if (openingFile) {
		return (
			<Suspense fallback={null}>
				<RestoreShell
					mobile={mobile}
					onClose={() => setOpeningFile(false)}
					onRestored={() => {
						setOpeningFile(false);
						if (onComplete) onComplete();
						else setDone("opened");
					}}
				/>
			</Suspense>
		);
	}

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
					<h1 className="text-2xl mb-2">
						{done === "created" ? <Trans>Vault ready</Trans> : <Trans>Vault unlocked</Trans>}
					</h1>
					<p className="text-sm text-muted-foreground">
						<Trans>You can close this tab and use the {shell.appName} popup.</Trans>
					</p>
				</div>
			</div>
		);
	}

	return (
		<VaultSetup
			mobile={mobile}
			mode={mode}
			onModeChange={setMode}
			adding={adding}
			onCreate={async (password, label) => {
				// createVault returns the one-time recovery code to display first.
				setRecoveryCode(await createVault(password, label));
			}}
			onUnlock={async (password) => {
				await unlock(password);
				if (onComplete) onComplete();
				else setDone("opened");
			}}
			onJoin={
				canJoin
					? async (pairingCode, password) => {
							// startJoin creates a new vault and pairs into it, unlocking on success; then
							// land on the terminal screen (or hand back to the mobile host).
							await startJoin(pairingCode, { kind: "password", password });
							if (onComplete) onComplete();
							else setDone("opened");
						}
					: undefined
			}
			joining={joining}
			joinError={joinError}
			onOpenFile={canRestore ? () => setOpeningFile(true) : undefined}
		/>
	);
}

export default function OptionsApp({
	onComplete,
	mobile,
	screen,
	preferredLocale,
}: {
	onComplete?: () => void;
	mobile?: boolean;
	/** Force a screen (single-window hosts pass this); otherwise read from `?screen=`. */
	screen?: OptionsScreen;
	/** Host-detected locale tag (mobile passes Capacitor Device); else navigator.language. */
	preferredLocale?: string;
} = {}) {
	// `?screen=import` (from Settings) routes to the import flow instead of setup.
	const active = screen ?? new URLSearchParams(window.location.search).get("screen");
	return (
		<ErrorBoundary>
			<LocaleGate preferredLocale={preferredLocale}>
				<ThemeProvider>
					<VaultRegistryProvider>
						<VaultProvider>
							{active === "import" ? (
								<Suspense fallback={null}>
									<ImportShell onClose={onComplete} />
								</Suspense>
							) : active === "restore" ? (
								<Suspense fallback={null}>
									<RestoreShell onClose={onComplete} mobile={mobile} />
								</Suspense>
							) : (
								<SetupShell onComplete={onComplete} mobile={mobile} />
							)}
						</VaultProvider>
					</VaultRegistryProvider>
				</ThemeProvider>
			</LocaleGate>
		</ErrorBoundary>
	);
}
