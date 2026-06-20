import { App, type Platform, PlatformProvider } from "@core/index";
import { createRoot } from "react-dom/client";
import "@core/styles/index.css";
import { mobileAutofill } from "./adapters/autofill";
import { mobileClipboard } from "./adapters/clipboard";
import { mobileCrypto } from "./adapters/crypto";
import { mobileShell } from "./adapters/shell";
import { mobileStorage } from "./adapters/storage";

const platform: Platform = {
	storage: mobileStorage,
	crypto: mobileCrypto,
	autofill: mobileAutofill,
	shell: mobileShell,
	clipboard: mobileClipboard,
};

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// Mobile webview fills the screen; let the root track the viewport so h-dvh works.
document.documentElement.style.height = "100%";
document.body.style.height = "100%";

createRoot(root).render(
	<PlatformProvider platform={platform}>
		<App />
	</PlatformProvider>,
);
