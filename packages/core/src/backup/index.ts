import type { HttpTransport } from "../adapters/http";
import { createDropboxTarget } from "./dropbox";
import { createS3Target, s3SigningTransport } from "./s3";
import type { BackupTarget, BackupTransport, ProviderConfig } from "./types";
import { createWebdavTarget, webdavSigningTransport } from "./webdav";

export { type BackupResult, backupKey, runBackup, selectForPruning } from "./orchestrator";
export { sha256Hex } from "./sigv4";
export type {
	BackupHttpRequest,
	BackupHttpResponse,
	BackupObject,
	BackupTarget,
	BackupTransport,
	DropboxConfig,
	ProviderConfig,
	S3Config,
	WebdavConfig,
} from "./types";

/**
 * Build a BackupTarget for a provider config. `transport` overrides how requests reach the
 * provider and who authenticates them: the desktop passes one backed by Rust, since its webview
 * has neither the credentials nor a CORS grant. Dropbox has no override because its OAuth
 * connect is extension-only (`shell.connectBackupOAuth`), so no other platform can hold one.
 */
export function createTarget(cfg: ProviderConfig, transport?: BackupTransport): BackupTarget {
	switch (cfg.kind) {
		case "s3":
			return createS3Target(cfg, transport);
		case "webdav":
			return createWebdavTarget(cfg, transport);
		case "dropbox":
			// Bearer auth is the target's own, so a transport here only carries the requests.
			return createDropboxTarget(cfg, transport);
	}
}

/**
 * A transport that authenticates here and sends over `send`.
 *
 * For a platform that holds the credentials but cannot reach a provider from the process its UI
 * runs in, which is mobile: no S3 endpoint or WebDAV server grants CORS to `capacitor://localhost`
 * or `https://localhost`, but the secret was just unwrapped from the open vault, so only the
 * sending needs to leave the webview. The desktop needs the stronger thing (its credentials never
 * enter the webview at all) and passes a whole `BackupTransport` instead.
 *
 * Undefined for Dropbox, whose OAuth connect is extension-only, so no platform needing this can
 * have one configured.
 */
export function signingTransport(
	cfg: ProviderConfig,
	send: HttpTransport,
): BackupTransport | undefined {
	switch (cfg.kind) {
		case "s3":
			return s3SigningTransport(cfg, send);
		case "webdav":
			return webdavSigningTransport(cfg, send);
		case "dropbox":
			return undefined;
	}
}
