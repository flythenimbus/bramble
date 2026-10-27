/// <reference types="chrome" />

import type { ClipboardAdapter } from "@core/adapters/clipboard";
import { api } from "./platform-api";

export const extensionClipboard: ClipboardAdapter = {
	async copy(text: string) {
		await navigator.clipboard.writeText(text);
		// Fire-and-forget: the background SW + offscreen pair runs the timed clear,
		// surviving popup close.
		try {
			await api.runtime.sendMessage({ type: "CLIPBOARD_SCHEDULE_CLEAR" });
		} catch {
			// Best-effort: if the background can't accept the schedule, the copy
			// still worked. Don't fail the user-visible operation.
		}
	},
	// Non-sensitive copy (donation address, URL): no scheduled clear, so it persists.
	async copyPlain(text: string) {
		await navigator.clipboard.writeText(text);
	},
};
