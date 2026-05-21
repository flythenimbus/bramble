import { App, type Platform, PlatformProvider } from "@core/index";
import { createRoot } from "react-dom/client";
import "@core/styles/index.css";
import { extensionAutofill } from "./autofill";
import { extensionCrypto } from "./crypto";
import { extensionShell } from "./shell";
import { extensionStorage } from "./storage";

const platform: Platform = {
	storage: extensionStorage,
	crypto: extensionCrypto,
	autofill: extensionAutofill,
	shell: extensionShell,
};

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
	<PlatformProvider platform={platform}>
		<App />
	</PlatformProvider>,
);
