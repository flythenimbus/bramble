import type { ProviderConfig } from "./types";

// Device-local backup targets, per vault. Non-secret fields are stored in the clear via
// storage.setMeta; credentials are VEK-wrapped (see useBackup). Never synced.
// See docs/cloud-storage-backups.md.

/** Legacy device-global list, shared by every vault. Migration input only (see
 * migrateBackupTargetsToVaults); live reads go through backupTargetsKeyFor. */
export const BACKUP_TARGETS_KEY = "backup.targets";
// Legacy single-target key, folded into the array by the same migration (unreleased format).
export const BACKUP_CONFIG_KEY = "backup.config";

/** Where one vault's targets live: `backup.targets:<vaultId>`, mirroring the sync keys. */
export function backupTargetsKeyFor(vaultId: string): string {
	return `${BACKUP_TARGETS_KEY}:${vaultId}`;
}

/** True for any vault's target-list key, for storage-change watchers that can't name the id. */
export function isBackupTargetsKey(key: string): boolean {
	return key.startsWith(`${BACKUP_TARGETS_KEY}:`);
}

export type BackupFrequency = "off" | "daily" | "weekly" | "monthly";

/** Secret credential fields sealed under the vault key. `wrap` is absent on every target
 * written before the desktop's OS-held option existed, so absent reads as "vek". */
export interface WrappedCreds {
	wrap?: "vek";
	iv: string;
	ciphertext: string;
}

/** Not here at all: the desktop keeps this target's credentials in the OS credential store and
 * authenticates in its own process, so nothing secret is in the config. See
 * adapters/backup-creds.ts and docs/cloud-storage-backups.md. */
export interface OsHeldCreds {
	wrap: "os";
}

export type TargetCreds = WrappedCreds | OsHeldCreds;

export function credsAreOsHeld(creds: TargetCreds): creds is OsHeldCreds {
	return creds.wrap === "os";
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
	creds: TargetCreds; // VEK-wrapped secret fields, or a marker that the OS holds them
	/** Adopted from the pre-per-vault device-global list, so its snapshots keep the old shared
	 * folder layout (see targetPrefixFor). Cleared once the user picks a folder for this vault. */
	sharedFolder?: boolean;
	lastBackupAt?: number;
	lastVaultHash?: string;
	lastError?: string;
}

/** What one target's backup attempt produced: a vault hash on success, a message on failure. */
export interface BackupOutcome {
	hash?: string;
	error?: string;
}

/**
 * Fold outcomes into the stored targets, by id. The rule both callers need: success stamps
 * the time and hash and CLEARS the previous error, failure records the error and leaves the
 * last-good stamps alone, and a target with no outcome is untouched (the list can change
 * while uploads run). Kept in one place because two copies of it drift into two different
 * ideas of when a target is "up to date".
 */
export function applyBackupOutcomes(
	targets: BackupTargetConfig[],
	outcomes: Map<string, BackupOutcome>,
	now: number,
): BackupTargetConfig[] {
	return targets.map((t) => {
		const r = outcomes.get(t.id);
		if (!r) return t;
		return r.error !== undefined
			? { ...t, lastError: r.error }
			: { ...t, lastBackupAt: now, lastVaultHash: r.hash, lastError: undefined };
	});
}

type S3Secrets = { accessKeyId: string; secretAccessKey: string };
type WebdavSecrets = { username: string; password: string };
type DropboxSecrets = { refreshToken: string };
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
 * Where a SHARED target's snapshots live under its base prefix. The default (first) vault keeps
 * the un-suffixed base so existing backups keep going; every other vault gets a SIBLING
 * `<base>-<id>` namespace — a sibling, not a `<base>/<id>` subfolder, so the base's prefix listing
 * (`<base>/`) can't sweep up other vaults' files during keep-N retention. Only reached for targets
 * carried over from the device-global list; see targetPrefixFor.
 */
export function vaultBackupPrefix(base: string, vaultId: string, isDefault: boolean): string {
	return isDefault ? base : `${base}-${vaultId}`;
}

/**
 * The object-key prefix one vault's snapshots use for a target. Targets are per-vault now, so a
 * vault's own target uses exactly the folder the user typed. A target inherited from the old
 * device-global list (`sharedFolder`) instead keeps the derived per-vault layout it has been
 * writing to, so an upgrade never strands or collides with existing snapshots. Used by both the
 * manual "Back up now" and the scheduled run, so their files land in the same place.
 */
export function targetPrefixFor(
	cfg: BackupTargetConfig,
	vaultId: string,
	isDefault: boolean,
): string {
	const base = backupPrefix(cfg);
	return cfg.sharedFolder ? vaultBackupPrefix(base, vaultId, isDefault) : base;
}

/** The metadata slice the target migration needs; the storage adapter satisfies it. */
export interface BackupMetaStore {
	getMeta<T>(key: string): Promise<T | undefined>;
	setMeta<T>(key: string, value: T): Promise<void>;
	removeMeta(key: string): Promise<void>;
}

/**
 * One-shot: hand the pre-per-vault device-global target list to every registered vault, then drop
 * the global keys. Every vault adopts the list (rather than only the default one) so no vault
 * silently stops being backed up by the upgrade; each copy is marked `sharedFolder` so its
 * snapshots stay in the folder that vault already uses. From here the lists are independent:
 * editing or removing a target in one vault leaves the others alone (issue #49).
 *
 * Idempotent and crash-safe: the per-vault writes land BEFORE the global keys are removed, so an
 * interrupted run simply repeats, and a vault that already has a list is never overwritten.
 */
export async function migrateBackupTargetsToVaults(
	store: BackupMetaStore,
	vaultIds: string[],
	newId: () => string,
): Promise<void> {
	if (vaultIds.length === 0) return; // registry not ready: nothing to migrate onto yet
	const shared = await store.getMeta<BackupTargetConfig[]>(BACKUP_TARGETS_KEY);
	// The even older single-target shape, if it never reached the array form.
	const legacy = shared
		? undefined
		: await store.getMeta<Omit<BackupTargetConfig, "id">>(BACKUP_CONFIG_KEY);
	if (!shared && !legacy) return;
	const list = (shared ?? [{ ...(legacy as Omit<BackupTargetConfig, "id">), id: newId() }]).map(
		(t) => ({ ...t, sharedFolder: true }),
	);
	for (const id of vaultIds) {
		const key = backupTargetsKeyFor(id);
		if ((await store.getMeta<BackupTargetConfig[]>(key)) !== undefined) continue;
		await store.setMeta(key, list);
	}
	await store.removeMeta(BACKUP_TARGETS_KEY);
	await store.removeMeta(BACKUP_CONFIG_KEY);
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
