import { OptionsApp, type Platform, PlatformProvider } from "@core/index";
import { createRoot } from "react-dom/client";
import "@core/styles/index.css";
import { extensionAutofill } from "./autofill";
import { extensionClipboard } from "./clipboard";
import { extensionCrypto } from "./crypto";
import { extensionDesktopLink } from "./desktop-link";
import { extensionShell, extensionTarget } from "./shell";
import { extensionStorage } from "./storage";
import { connectViewPort } from "./view-port";

// Hold a port for this view's lifetime so "Immediate" auto-lock can lock the vault when
// the last extension view closes (background/view-lock.ts). No-op in other auto-lock modes.
connectViewPort();

const platform: Platform = {
	target: extensionTarget,
	storage: extensionStorage,
	crypto: extensionCrypto,
	autofill: extensionAutofill,
	shell: extensionShell,
	clipboard: extensionClipboard,
	desktopLink: extensionDesktopLink,
};

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
	<PlatformProvider platform={platform}>
		<OptionsApp />
	</PlatformProvider>,
);
