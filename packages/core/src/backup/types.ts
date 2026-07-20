// Types for the cloud backup storage layer. A BackupTarget is the minimal
// object-store surface the orchestrator needs; S3 and WebDAV both implement it.
// See docs/cloud-storage-backups.md.

export interface BackupObject {
	key: string;
	size: number;
	lastModified?: string;
}

export interface BackupTarget {
	put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
	get(key: string): Promise<Uint8Array>;
	list(prefix: string): Promise<BackupObject[]>;
	remove(key: string): Promise<void>;
}

export interface S3Config {
	kind: "s3";
	endpoint: string; // e.g. https://s3.us-west-002.backblazeb2.com
	region: string;
	bucket: string;
	prefix?: string;
	accessKeyId: string;
	secretAccessKey: string;
}

export interface WebdavConfig {
	kind: "webdav";
	serverUrl: string; // e.g. https://host/remote.php/dav/files/me/
	// No folder field: the user's folder is the object-key prefix (see backupPrefix),
	// so it arrives in the keys rather than being baked into the base URL.
	username: string;
	password: string;
}

export interface DropboxConfig {
	kind: "dropbox";
	refreshToken: string; // long-lived; mints access tokens on demand
	accessToken?: string; // optional warm token, else minted lazily from the refresh token
	path?: string; // optional subfolder within the connected app folder
}

export type ProviderConfig = S3Config | WebdavConfig | DropboxConfig;
