export interface PopOutHandoff {
	path: string;
	draft?: unknown;
}

export type OptionsScreen = "import";

export interface ShellAdapter {
	openSetup(screen?: OptionsScreen): Promise<void>;
	hasFilePicker(): boolean;
	getCurrentTabOrigin(): Promise<string | null>;
	popOut(handoff?: PopOutHandoff): Promise<void>;
	consumeHandoff(): Promise<PopOutHandoff | null>;
	isDetached(): boolean;
	scanQrFromActiveTab(): Promise<string | null>;
}
