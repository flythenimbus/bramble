import { App, OptionsApp, type Platform, PlatformProvider } from "@core/index";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@core/styles/index.css";
import "./styles/mobile.css";
import { mobileAutofill } from "./adapters/autofill";
import { mobileBiometric } from "./adapters/biometric";
import { mobileClipboard } from "./adapters/clipboard";
import { mobileCrypto } from "./adapters/crypto";
import { mobileShell, registerOpenSetup } from "./adapters/shell";
import { mobileStorage } from "./adapters/storage";
import { startAutoLock } from "./auto-lock";
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
	useEffect(
		() => registerOpenSetup((screen) => setView(screen === "import" ? "import" : "setup")),
		[],
	);

	// Auto-lock after the configured inactivity timeout (background time counts as
	// inactivity); honors the "Never" setting. onExternalLock then re-locks the UI.
	useEffect(() => startAutoLock(), []);

	// Run ongoing roster sync while unlocked + enrolled (started on unlock).
	useEffect(() => initRosterSync(), []);

	if (view === "app") return <App />;
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

createRoot(root).render(
	<PlatformProvider platform={platform}>
		<Root />
	</PlatformProvider>,
);
