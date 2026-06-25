import { App as CapacitorApp } from "@capacitor/app";
import { PREF_AUTOLOCK_MINUTES } from "@core/hooks/usePrefs";
import { App, OptionsApp, type PendingLogin, type Platform, PlatformProvider } from "@core/index";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@core/styles/index.css";
import "./styles/mobile.css";
import { mobileAutofill } from "./adapters/autofill";
import { mobileBiometric } from "./adapters/biometric";
import { mobileClipboard } from "./adapters/clipboard";
import { mobileCrypto } from "./adapters/crypto";
import { mobileShell, registerOpenSetup, resolveAppVersion } from "./adapters/shell";
import { mobileStorage } from "./adapters/storage";
import { startAutoLock } from "./auto-lock";
import { consumePendingAutofillSave } from "./autofill-pending";
import { initRosterSync } from "./sync/sync-manager";

const platform: Platform = {
	storage: mobileStorage,
	crypto: mobileCrypto,
	autofill: mobileAutofill,
	shell: mobileShell,
	clipboard: mobileClipboard,
	biometric: mobileBiometric,
};

// Single-window host: `App` is the vault/unlock UI; the setup flow (create/open a
// vault) is `OptionsApp`, shown when `shell.openSetup()` fires and dismissed when
// it completes. The WASM crypto + filesystem are process singletons, so remounting
// `App` afterwards reflects the now-unlocked vault.
function Root() {
	// "app" = vault/unlock UI; "setup" = create/open a vault; "import" = import wizard.
	// The last two render OptionsApp and dismiss back to "app" on completion/close.
	const [view, setView] = useState<"app" | "setup" | "import">("app");
	const [pendingLogin, setPendingLogin] = useState<PendingLogin | null>(null);
	useEffect(
		() => registerOpenSetup((screen) => setView(screen === "import" ? "import" : "setup")),
		[],
	);

	// Autofill "save login" handoff: the native AutofillService captures a sign-in, writes
	// it to a file, and launches us. Pick it up on launch and on resume; App opens a
	// prefilled add-login form once the vault is unlocked. No-op on iOS (no file).
	useEffect(() => {
		const check = () => {
			void consumePendingAutofillSave().then((p) => {
				if (p) setPendingLogin(p);
			});
		};
		check();
		const sub = CapacitorApp.addListener("resume", check);
		return () => {
			void sub.then((h) => h.remove());
		};
	}, []);

	// Auto-lock after the configured inactivity timeout (background time counts as
	// inactivity); honors the "Never" setting. onExternalLock then re-locks the UI.
	useEffect(() => startAutoLock(), []);

	// Run ongoing roster sync while unlocked + enrolled (started on unlock).
	useEffect(() => initRosterSync(), []);

	if (view === "app") return <App pendingLogin={pendingLogin ?? undefined} />;
	return (
		<OptionsApp
			onComplete={() => setView("app")}
			mobile
			screen={view === "import" ? "import" : undefined}
		/>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// Mobile defaults the auto-lock timeout to "Immediately" (-1) on first run, so the vault
// and autofill both re-lock when you leave the app unless you pick a longer window. Set it
// before the first render so the settings UI and auto-lock read the same value.
void (async () => {
	if ((await mobileStorage.getMeta<number>(PREF_AUTOLOCK_MINUTES)) === undefined) {
		await mobileStorage.setMeta(PREF_AUTOLOCK_MINUTES, -1);
	}
	await resolveAppVersion();
	createRoot(root).render(
		<PlatformProvider platform={platform}>
			<Root />
		</PlatformProvider>,
	);
})();
