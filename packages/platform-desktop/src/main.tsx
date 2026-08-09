import { App, OptionsApp, type OptionsScreen, type Platform, PlatformProvider } from "@core/index";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.css";
import "./styles/desktop.css";
import { desktopAutofill } from "./adapters/autofill";
import { desktopClipboard } from "./adapters/clipboard";
import { desktopCrypto } from "./adapters/crypto";
import { desktopPairing } from "./adapters/pairing";
import { desktopShell, registerOpenSetup, resolveAppVersion } from "./adapters/shell";
import { desktopStorage } from "./adapters/storage";
import { onVaultStateChange } from "./adapters/vault-session";
import { initRosterSync } from "./sync/roster";

const platform: Platform = {
	target: "desktop",
	storage: desktopStorage,
	crypto: desktopCrypto,
	autofill: desktopAutofill,
	shell: desktopShell,
	clipboard: desktopClipboard,
	pairing: desktopPairing,
	// biometric: Touch ID / Windows Hello is phase 1; nothing on Linux.
	// exchange: iOS only.
};

function Root() {
	// "app" = vault/unlock UI; the rest render OptionsApp and dismiss back to "app".
	// One window, so these are views rather than the extension's separate options page.
	const [view, setView] = useState<"app" | "setup" | "import" | "restore">("app");

	useEffect(
		() =>
			registerOpenSetup((screen?: OptionsScreen) =>
				setView(screen === "import" ? "import" : screen === "restore" ? "restore" : "setup"),
			),
		[],
	);

	// Ongoing sync follows the lock state from here on: it starts on unlock and stops on lock.
	useEffect(() => initRosterSync(), []);

	// Locking clears the search index, so a panel left open would go on accepting typing and
	// answering "No matches" to everything the vault still holds. Dismiss it instead: the hotkey
	// already routes to this window while locked, so there is a way back.
	useEffect(
		() =>
			onVaultStateChange((locked) => {
				if (locked) void invoke("spotlight_hide");
			}),
		[],
	);

	if (view === "app") return <App />;
	return (
		<OptionsApp
			onComplete={() => setView("app")}
			screen={view === "import" ? "import" : view === "restore" ? "restore" : undefined}
		/>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

void (async () => {
	// Settings' "About" row reads this synchronously, so resolve it before the first render.
	await resolveAppVersion();
	createRoot(root).render(
		<PlatformProvider platform={platform}>
			<Root />
		</PlatformProvider>,
	);
})();
