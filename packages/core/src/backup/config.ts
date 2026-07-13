import type { ProviderConfig } from "./types";

// Device-local backup config. Non-secret fields are stored in the clear via
// storage.setMeta; the credential fields are VEK-wrapped (see useBackup). Never
// synced. See docs/cloud-storage-backups.md.
export const BACKUP_CONFIG_KEY = "backup.config";

export type BackupFrequency = "off" | "daily" | "weekly" | "monthly";

export interface WrappedCreds {
	iv: string;
	ciphertext: string;
}

export interface StoredBackupConfig {
	providerId: string; // provider tile id (drives the icon/name), e.g. "backblaze"
	provider: "s3" | "webdav";
	endpoint?: string;
	region?: string;
	bucket?: string;
	prefix?: string;
	serverUrl?: string;
	path?: string;
	frequency: BackupFrequency;
	keep: number;
	creds: WrappedCreds; // VEK-wrapped JSON of the secret credential fields
	lastBackupAt?: number;
	lastVaultHash?: string;
	lastError?: string;
}

export type S3Secrets = { accessKeyId: string; secretAccessKey: string };
export type WebdavSecrets = { username: string; password: string };
export type BackupSecrets = S3Secrets | WebdavSecrets;

/** Combine stored (non-secret) config with unwrapped secrets into a ProviderConfig. */
export function toProviderConfig(cfg: StoredBackupConfig, secrets: BackupSecrets): ProviderConfig {
	if (cfg.provider === "s3") {
		const s = secrets as S3Secrets;
		return {
			kind: "s3",
			endpoint: cfg.endpoint ?? "",
			region: cfg.region ?? "",
			bucket: cfg.bucket ?? "",
			prefix: cfg.prefix,
			accessKeyId: s.accessKeyId,
			secretAccessKey: s.secretAccessKey,
		};
	}
	const s = secrets as WebdavSecrets;
	return {
		kind: "webdav",
		serverUrl: cfg.serverUrl ?? "",
		path: cfg.path,
		username: s.username,
		password: s.password,
	};
}

/** The folder backups live under: the user's S3 prefix if set, else "bramble". */
export function backupPrefix(cfg: StoredBackupConfig): string {
	return cfg.prefix?.trim().replace(/\/+$/, "") || "bramble";
}
