import { createRoot } from "react-dom/client";
import { App, PlatformProvider, type Platform } from "@core/index";
import "@core/styles/index.css";
import { extensionStorage } from "./storage";
import { extensionCrypto } from "./crypto";
import { extensionAutofill } from "./autofill";

const platform: Platform = {
  storage: extensionStorage,
  crypto: extensionCrypto,
  autofill: extensionAutofill,
};

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// First-time vault setup will render here in a later phase. For now, both popup
// and options page show the same App so the design renders end-to-end.
createRoot(root).render(
  <PlatformProvider platform={platform}>
    <App />
  </PlatformProvider>,
);
