import { Clipboard } from "@capacitor/clipboard";
import type { ClipboardAdapter } from "@core/index";

// Capacitor's clipboard is plain-text on mobile with no built-in timeout, so we
// run our own auto-clear timer. NOTE: a JS timer does not survive the app being
// backgrounded/killed; a hardened build needs a small native plugin (and the
// Android EXTRA_IS_SENSITIVE flag). Good enough for the POC.
const CLEAR_AFTER_MS = 30_000;
let clearTimer: ReturnType<typeof setTimeout> | undefined;

export const mobileClipboard: ClipboardAdapter = {
	async copy(text) {
		await Clipboard.write({ string: text });
		if (clearTimer) clearTimeout(clearTimer);
		clearTimer = setTimeout(() => {
			void Clipboard.write({ string: "" });
		}, CLEAR_AFTER_MS);
	},
};
