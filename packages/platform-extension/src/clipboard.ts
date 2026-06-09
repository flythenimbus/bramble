/// <reference types="chrome" />
import type { ClipboardAdapter } from "@core/adapters/clipboard";

/** SHA-256 hex fingerprint; the background uses it to verify ours is still on the clipboard before clearing. */
async function sha256Hex(text: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	const bytes = new Uint8Array(buf);
	let out = "";
	for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, "0");
	return out;
}

export const extensionClipboard: ClipboardAdapter = {
	async copy(text: string) {
		await navigator.clipboard.writeText(text);
		// Fire-and-forget: the background SW + offscreen pair runs the clear, surviving popup close.
		try {
			const expectedHash = await sha256Hex(text);
			await chrome.runtime.sendMessage({
				type: "CLIPBOARD_SCHEDULE_CLEAR",
				payload: { expectedHash },
			});
		} catch {
			// Best-effort: if the background can't accept the schedule, the
			// copy still worked. Don't fail the user-visible operation.
		}
	},
};
