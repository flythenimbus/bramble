import { App, type Platform, PlatformProvider } from "@core/index";
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

async function boot() {
	const root = document.getElementById("root");
	if (!root) throw new Error("missing #root");

	let initialPath: string | undefined;
	let initialDraft: unknown;
	let initialVaultId: string | undefined;

	if (extensionShell.isDetached()) {
		// In the popped-out window the popup.html's fixed 400px height would
		// leave dead space. Let html/body track the window so h-screen fills
		// the chrome window.
		document.documentElement.style.height = "100%";
		document.documentElement.style.width = "100%";
		document.documentElement.style.overflow = "auto";
		document.body.style.height = "100%";
		document.body.style.width = "100%";
		document.body.style.overflow = "auto";

		// Resume on the route the originating popup was showing, with any
		// half-filled form restored. consumeHandoff is a one-shot read.
		const handoff = await extensionShell.consumeHandoff();
		if (handoff) {
			initialPath = handoff.path;
			initialDraft = handoff.draft;
			initialVaultId = handoff.vaultId;
		} else if (!(await extensionCrypto.isLocked())) {
			// No handoff means this window was RELOADED rather than opened: the boot read already
			// consumed it. Fall back to the persisted route so a reload stays where it was, which
			// is how a window picks up a permission granted during its own lifetime.
			const stored = await extensionShell.restoreRoute?.();
			if (stored) initialPath = stored;
		}
	} else {
		// Normal popup: resume the route from the last close, but only when the session is
		// still unlocked. If locked, boot to "/" so the unlock screen shows (the route
		// guards would bounce a restored deep route there anyway).
		if (!(await extensionCrypto.isLocked())) {
			const stored = await extensionShell.restoreRoute?.();
			if (stored) initialPath = stored;
		}
	}

	createRoot(root).render(
		<PlatformProvider platform={platform}>
			<App initialPath={initialPath} initialDraft={initialDraft} initialVaultId={initialVaultId} />
		</PlatformProvider>,
	);
}

void boot();
