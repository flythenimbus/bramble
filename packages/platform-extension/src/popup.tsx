import { App, type Platform, PlatformProvider } from "@core/index";
import { createRoot } from "react-dom/client";
import "@core/styles/index.css";
import { extensionAutofill } from "./autofill";
import { extensionClipboard } from "./clipboard";
import { extensionCrypto } from "./crypto";
import { extensionShell } from "./shell";
import { extensionStorage } from "./storage";

const platform: Platform = {
	storage: extensionStorage,
	crypto: extensionCrypto,
	autofill: extensionAutofill,
	shell: extensionShell,
	clipboard: extensionClipboard,
};

// In the popped-out window the popup.html's fixed 400px height would leave
// dead space. Let html/body track the window so h-screen fills the chrome
// window.
if (extensionShell.isDetached()) {
	document.documentElement.style.height = "100%";
	document.documentElement.style.width = "100%";
	document.documentElement.style.overflow = "auto";
	document.body.style.height = "100%";
	document.body.style.width = "100%";
	document.body.style.overflow = "auto";
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
	<PlatformProvider platform={platform}>
		<App />
	</PlatformProvider>,
);
