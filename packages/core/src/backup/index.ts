import { createDropboxTarget } from "./dropbox";
import { createS3Target } from "./s3";
import type { BackupTarget, ProviderConfig } from "./types";
import { createWebdavTarget } from "./webdav";

export { type BackupResult, backupKey, runBackup, selectForPruning } from "./orchestrator";
export { sha256Hex } from "./sigv4";
export type {
	BackupObject,
	BackupTarget,
	DropboxConfig,
	ProviderConfig,
	S3Config,
	WebdavConfig,
} from "./types";

/** Build a BackupTarget for a provider config. */
export function createTarget(cfg: ProviderConfig): BackupTarget {
	switch (cfg.kind) {
		case "s3":
			return createS3Target(cfg);
		case "webdav":
			return createWebdavTarget(cfg);
		case "dropbox":
			return createDropboxTarget(cfg);
	}
}
