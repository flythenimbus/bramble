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

export interface BackupHttpRequest {
	method: string;
	url: string;
	headers?: Record<string, string>;
	body?: Uint8Array;
}

/** Body arrives whole: provider responses are a listing or one vault blob, never a stream. */
export interface BackupHttpResponse {
	status: number;
	ok: boolean;
	body: Uint8Array;
}

/**
 * How a provider's requests actually reach the network, and who authenticates them.
 *
 * The extension and mobile use the default: sign or authenticate in JS, then `fetch`. The
 * desktop passes its own, which hands the request to Rust, because its webview cannot reach a
 * provider at all (no S3 endpoint or WebDAV server grants CORS to `tauri://localhost`) and
 * because its credentials live in the OS credential store, so the only place that CAN
 * authenticate a request is the Rust side. A transport therefore owns the credentials: a
 * provider builds an unauthenticated request and the transport adds the auth.
 */
export interface BackupTransport {
	send(req: BackupHttpRequest): Promise<BackupHttpResponse>;
}

/** Decode a response body as text (XML listings, error documents). */
export function responseText(res: BackupHttpResponse): string {
	return new TextDecoder().decode(res.body);
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
