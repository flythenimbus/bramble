/// <reference types="chrome" />

import { api } from "./platform-api";

// "Immediate" auto-lock support (page side). While an extension view (popup, pop-out
// window, options page) is open it holds a runtime port; the background locks the vault
// when the last such port disconnects (see background/view-lock.ts). A real page close
// tears down this context and disconnects the port for good; if the service worker
// recycles under a still-open view instead, we reconnect so the view keeps counting.
const VIEW_PORT = "tp-view"; // must match background/view-lock.ts

export function connectViewPort(): void {
	try {
		const port = api.runtime.connect({ name: VIEW_PORT });
		port.onDisconnect.addListener(() => {
			// Fires when the SW recycles while this view is still open (a real page close
			// destroys this context first, so it never runs then). Reconnect after a beat
			// so a momentarily-unavailable runtime doesn't spin in a tight loop.
			setTimeout(connectViewPort, 500);
		});
	} catch {
		// No runtime (e.g. a non-extension context): nothing to hold open.
	}
}
