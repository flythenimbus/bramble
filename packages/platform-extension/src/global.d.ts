interface SaveFilePickerOptions {
	suggestedName?: string;
	types?: { description?: string; accept: Record<string, string[]> }[];
}
interface OpenFilePickerOptions {
	multiple?: boolean;
	types?: { description?: string; accept: Record<string, string[]> }[];
}

interface FileSystemHandlePermissionDescriptor {
	mode?: "read" | "readwrite";
}

declare global {
	interface Window {
		showSaveFilePicker(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
		showOpenFilePicker(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
	}
	interface FileSystemHandle {
		queryPermission(
			descriptor?: FileSystemHandlePermissionDescriptor,
		): Promise<"granted" | "denied" | "prompt">;
		requestPermission(
			descriptor?: FileSystemHandlePermissionDescriptor,
		): Promise<"granted" | "denied" | "prompt">;
	}
}

export {};
