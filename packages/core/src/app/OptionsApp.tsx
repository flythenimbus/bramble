import { Trans } from "@lingui/react/macro";
import { Check } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import type { OptionsScreen } from "../adapters/shell";
import { usePlatform } from "../context/PlatformContext";
import { useVault, VaultProvider } from "../hooks/useVault";
import { useVaultRegistry, VaultRegistryProvider } from "../hooks/useVaultRegistry";
import { RecoveryCodeDisplay } from "./components/RecoveryCodeDisplay";
import { ErrorBoundary } from "./ErrorBoundary";
import { ThemeProvider } from "./hooks/useTheme";
import { LocaleGate } from "./LocaleGate";
import { RestoreShell } from "./screens/Restore/RestoreShell";
import { VaultSetup, type VaultSetupMode } from "./screens/VaultSetup/VaultSetup";

// Lazy: the import pipeline + parsers (kdbx/csv) are heavy, so load them on demand. RestoreShell,
// by contrast, only decodes a .bramble blob with deps already in this bundle, so it's imported
// directly - it's the primary "Restore from backup" setup tab and a lazy fetch would lag the click.
const ImportShell = lazy(() =>
	import("./screens/Import/ImportShell").then((m) => ({ default: m.ImportShell })),
);

// `onComplete` lets a single-window host (mobile) return to its main UI instead of
// the "close this tab" terminal screen. When omitted (the extension's options tab),
// the terminal done screen is shown as before.
function SetupShell({ onComplete, mobile }: { onComplete?: () => void; mobile?: boolean }) {
	const { shell } = usePlatform();
	const { createVault, startJoin, joining, joinError } = useVault();
	const { vaults } = useVaultRegistry();
	const adding = vaults.length > 0;
	const [mode, setMode] = useState<VaultSetupMode>("create");
	// The pairing SAS for a join in progress, raised by the sync host once the channel is
	// authenticated and cleared when the join settles either way (so a retry never shows a stale
	// number). Held here rather than in VaultProvider: the setup screen is its only consumer.
	const [joinSas, setJoinSas] = useState<string | null>(null);
	useEffect(
		() =>
			shell.onSyncEvent((e) => {
				if (e.kind === "sas") setJoinSas(e.sas ?? null);
				else if (e.kind === "joined" || e.kind === "join-error") setJoinSas(null);
			}),
		[shell],
	);
	// "added" = a backup was restored isnto a new, locked vault (vaults already existed).
	const [done, setDone] = useState<null | "created" | "opened" | "added">(null);
	const [recoveryCode, setRecoveryCode] = useState<string | null>(null);

	if (recoveryCode) {
		return (
			<div className="min-h-screen bg-linear-to-br from-background via-background to-primary/5 flex items-center justify-center p-6">
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
			<div className="min-h-screen bg-linear-to-br from-background via-background to-primary/5 flex items-center justify-center p-6">
				<div className="w-full max-w-xl text-center">
					<div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-linear-to-br from-primary to-primary/80 mb-4">
						<Check className="w-9 h-9 text-primary-foreground" />
					</div>
					<h1 className="text-2xl mb-2">
						{done === "created" ? (
							<Trans>Vault ready</Trans>
						) : done === "added" ? (
							<Trans>Vault added</Trans>
						) : (
							<Trans>Vault unlocked</Trans>
						)}
					</h1>
					<p className="text-sm text-muted-foreground">
						{done === "added" ? (
							<Trans>
								Open it from the {shell.appName} popup and unlock it with its master password.
							</Trans>
						) : (
							<Trans>You can close this tab and use the {shell.appName} popup.</Trans>
						)}
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
			// Back to the main app, but only when there's one to return to (adding a vault on a
			// single-window host). First run has no back target; the extension closes the tab instead.
			onBack={adding && onComplete ? onComplete : undefined}
			onCreate={async (password, label) => {
				setRecoveryCode(await createVault(password, label));
			}}
			onJoin={async (pairingCode, password) => {
				await startJoin(pairingCode, { kind: "password", password });
				if (onComplete) onComplete();
				else setDone("opened");
			}}
			joining={joining}
			joinError={joinError}
			joinSas={joinSas}
			onRestore={({ addedNew }) => {
				if (onComplete) onComplete();
				else setDone(addedNew ? "added" : "opened");
			}}
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
								<RestoreShell onClose={onComplete} mobile={mobile} />
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
