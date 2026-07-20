import type { ProviderConfig } from "./types";

// Device-local backup targets. Non-secret fields are stored in the clear via
// storage.setMeta; credentials are VEK-wrapped (see useBackup). Never synced.
// See docs/cloud-storage-backups.md.
export const BACKUP_TARGETS_KEY = "backup.targets";
// Legacy single-target key, migrated into the array on first load (unreleased format).
export const BACKUP_CONFIG_KEY = "backup.config";

export type BackupFrequency = "off" | "daily" | "weekly" | "monthly";

export interface WrappedCreds {
	iv: string;
	ciphertext: string;
}

/** One configured backup destination. The vault can have many, each on its own schedule. */
export interface BackupTargetConfig {
	id: string;
	providerId: string; // provider tile id (drives the icon/name), e.g. "backblaze"
	provider: "s3" | "webdav" | "dropbox";
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
export type DropboxSecrets = { refreshToken: string };
export type BackupSecrets = S3Secrets | WebdavSecrets | DropboxSecrets;

/** Combine a target's non-secret config with unwrapped secrets into a ProviderConfig. */
export function toProviderConfig(cfg: BackupTargetConfig, secrets: BackupSecrets): ProviderConfig {
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
	if (cfg.provider === "dropbox") {
		const s = secrets as DropboxSecrets;
		return { kind: "dropbox", refreshToken: s.refreshToken, path: cfg.path };
	}
	const s = secrets as WebdavSecrets;
	return {
		kind: "webdav",
		serverUrl: cfg.serverUrl ?? "",
		username: s.username,
		password: s.password,
	};
}

/**
 * The folder backups live under, else "bramble". This is the user's own folder field:
 * `prefix` on S3, `path` on WebDAV (where it used to be baked into the base URL, which
 * nested snapshots one level deeper than the user asked for). Dropbox is excluded: its
 * `path` is a container folder inside the app folder and keeps the "bramble" subfolder.
 */
export function backupPrefix(cfg: BackupTargetConfig): string {
	const folder = cfg.provider === "webdav" ? cfg.path : cfg.prefix;
	return folder?.trim().replace(/^\/+|\/+$/g, "") || "bramble";
}

/**
 * Where one vault's snapshots live under a target's base prefix. The default (first) vault keeps
 * the un-suffixed base so existing backups keep going; every other vault gets a SIBLING
 * `<base>-<id>` namespace — a sibling, not a `<base>/<id>` subfolder, so the base's prefix listing
 * (`<base>/`) can't sweep up other vaults' files during keep-N retention. Used by both the manual
 * "Back up now" (active vault) and the scheduled all-vaults run, so their files land in the same place.
 */
export function vaultBackupPrefix(base: string, vaultId: string, isDefault: boolean): string {
	return isDefault ? base : `${base}-${vaultId}`;
}

/**
 * Accept a full bucket URL pasted into the endpoint or bucket field and split it:
 * host -> endpoint, first path segment -> bucket, the rest -> prefix. A plain
 * bucket name plus a separate endpoint passes through unchanged.
 */
export function normalizeS3(input: { endpoint: string; bucket: string; prefix?: string }): {
	endpoint: string;
	bucket: string;
	prefix?: string;
} {
	const endpoint = input.endpoint.trim();
	const bucket = input.bucket.trim();
	const prefix = (input.prefix ?? "").trim().replace(/^\/+|\/+$/g, "");
	// A URL pasted into either field is authoritative; otherwise read the endpoint.
	const src = /^https?:\/\//i.test(bucket) ? bucket : endpoint;
	try {
		const u = new URL(src);
		const origin = `${u.protocol}//${u.host}`;
		const segs = u.pathname.split("/").filter(Boolean);
		if (segs.length === 0) return { endpoint: origin, bucket, prefix: prefix || undefined };
		const first = segs[0] ?? "";
		const merged = [segs.slice(1).join("/"), prefix].filter(Boolean).join("/");
		return { endpoint: origin, bucket: first, prefix: merged || undefined };
	} catch {
		return { endpoint, bucket, prefix: prefix || undefined };
	}
}
