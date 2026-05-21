export interface StorageAdapter {
	hasVaultHandle(): Promise<boolean>;
	selectVaultFile(mode: "create" | "open"): Promise<void>;
	readVaultBlob(): Promise<Uint8Array>;
	writeVaultBlob(blob: Uint8Array): Promise<void>;
	getMeta<T>(key: string): Promise<T | undefined>;
	setMeta<T>(key: string, value: T): Promise<void>;
}
