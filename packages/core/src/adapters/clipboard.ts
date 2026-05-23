export interface ClipboardAdapter {
	copy(text: string): Promise<void>;
}
