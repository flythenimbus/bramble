import { App as CapacitorApp } from "@capacitor/app";
import { App, OptionsApp, type Platform, PlatformProvider } from "@core/index";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@core/styles/index.css";
import "./styles/mobile.css";
import { mobileAutofill } from "./adapters/autofill";
import { mobileClipboard } from "./adapters/clipboard";
import { lockForLifecycle, mobileCrypto } from "./adapters/crypto";
import { mobileShell, registerOpenSetup } from "./adapters/shell";
import { mobileStorage } from "./adapters/storage";

const platform: Platform = {
	storage: mobileStorage,
	crypto: mobileCrypto,
	autofill: mobileAutofill,
	shell: mobileShell,
	clipboard: mobileClipboard,
};

// Single-window host: `App` is the vault/unlock UI; the setup flow (create/open a
// vault) is `OptionsApp`, shown when `shell.openSetup()` fires and dismissed when
// it completes. The WASM crypto + filesystem are process singletons, so remounting
// `App` afterwards reflects the now-unlocked vault.
function Root() {
	const [setup, setSetup] = useState(false);
	useEffect(() => registerOpenSetup(() => setSetup(true)), []);

	// Lock the vault whenever the app is backgrounded (a password manager should not
	// stay unlocked behind the app switcher). onExternalLock then re-locks the UI.
	useEffect(() => {
		const handle = CapacitorApp.addListener("pause", () => {
			void lockForLifecycle();
		});
		return () => {
			void handle.then((h) => h.remove());
		};
	}, []);

	return setup ? <OptionsApp onComplete={() => setSetup(false)} mobile /> : <App />;
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
	<PlatformProvider platform={platform}>
		<Root />
	</PlatformProvider>,
);
