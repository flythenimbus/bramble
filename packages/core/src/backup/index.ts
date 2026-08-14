import { createDropboxTarget } from "./dropbox";
import { createS3Target } from "./s3";
import type { BackupTarget, BackupTransport, ProviderConfig } from "./types";
import { createWebdavTarget } from "./webdav";

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
			return createDropboxTarget(cfg);
	}
}
