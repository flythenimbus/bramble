import type { ClipboardAdapter } from "@core/adapters/clipboard";
import { clear, writeText } from "@tauri-apps/plugin-clipboard-manager";

// Copied secrets are cleared after this long, matching the extension's behaviour.
const CLEAR_AFTER_MS = 30_000;

let pending: ReturnType<typeof setTimeout> | null = null;

export const desktopClipboard: ClipboardAdapter = {
	async copy(text: string) {
		await writeText(text);
		// Only the most recent copy is worth clearing; an older timer would wipe it early.
		if (pending) clearTimeout(pending);
		pending = setTimeout(() => {
			pending = null;
			// Best-effort: the user may have copied something else since, and clearing that
			// would be worse than leaving ours. Reading first needs clipboard read permission,
			// so for now accept the small window. Revisit with the spotlight work.
			void clear().catch(() => {});
		}, CLEAR_AFTER_MS);
	},
};
