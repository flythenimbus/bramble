/**
 * Copies sensitive text and schedules an automatic clear so it doesn't linger
 * in the OS clipboard. Implementations must write from a context with clipboard
 * permission (e.g. the popup) and ensure the clear runs even after it goes away.
 */
export interface ClipboardAdapter {
	copy(text: string): Promise<void>;
	/**
	 * Copy non-sensitive text (e.g. a donation wallet address, a URL) WITHOUT the auto-clear,
	 * so it persists for the user to paste into another app. Optional; callers fall back to
	 * `copy` when absent.
	 */
	copyPlain?(text: string): Promise<void>;
}
