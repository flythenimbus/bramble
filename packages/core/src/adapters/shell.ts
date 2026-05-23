export interface ShellAdapter {
	// Open the platform's "setup" UI (e.g. extension options page in a full
	// tab, where FSA file pickers work reliably).
	openSetup(): Promise<void>;
	hasFilePicker(): boolean;
	getCurrentTabOrigin(): Promise<string | null>;
	// dismiss on focus loss. Closes the originating popup.
	popOut(): Promise<void>;
	isDetached(): boolean;
}
