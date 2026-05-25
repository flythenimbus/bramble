export interface PopOutHandoff {
	path: string;
	draft?: unknown;
}

export interface ShellAdapter {
	// Open the platform's "setup" UI (e.g. extension options page in a full
	// tab, where FSA file pickers work reliably).
	openSetup(): Promise<void>;
	hasFilePicker(): boolean;
	getCurrentTabOrigin(): Promise<string | null>;
	popOut(handoff?: PopOutHandoff): Promise<void>;
	consumeHandoff(): Promise<PopOutHandoff | null>;
	isDetached(): boolean;
	scanQrFromActiveTab(): Promise<string | null>;
}
