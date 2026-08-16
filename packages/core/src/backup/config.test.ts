import { describe, expect, it } from "vitest";
import type { BackupMetaStore, BackupTargetConfig } from "./config";
import {
	applyBackupOutcomes,
	BACKUP_CONFIG_KEY,
	BACKUP_TARGETS_KEY,
	backupPrefix,
	backupTargetsKeyFor,
	clearBackoff,
	isBackupTargetsKey,
	migrateBackupTargetsToVaults,
	normalizeS3,
	targetPrefixFor,
	toProviderConfig,
} from "./config";

const TARGET = {
	id: "t1",
	providerId: "nextcloud",
	frequency: "daily",
	keep: 30,
	creds: { iv: "", ciphertext: "" },
} satisfies Omit<BackupTargetConfig, "provider">;

describe("backupPrefix", () => {
	it("uses the WebDAV folder as the key prefix, not a nested subfolder", () => {
		const cfg: BackupTargetConfig = { ...TARGET, provider: "webdav", path: "backups" };
		expect(backupPrefix(cfg)).toBe("backups");
	});

	it("strips surrounding slashes from the WebDAV folder", () => {
		const cfg: BackupTargetConfig = { ...TARGET, provider: "webdav", path: "/backups/" };
		expect(backupPrefix(cfg)).toBe("backups");
	});

	it("falls back to bramble when the WebDAV folder is blank", () => {
		const cfg: BackupTargetConfig = { ...TARGET, provider: "webdav", path: "  " };
		expect(backupPrefix(cfg)).toBe("bramble");
	});

	it("still uses prefix for S3 and ignores path", () => {
		const cfg: BackupTargetConfig = {
			...TARGET,
			provider: "s3",
			prefix: "vaults",
			path: "ignored",
		};
		expect(backupPrefix(cfg)).toBe("vaults");
	});

	// Dropbox keeps `path` as a container folder inside the app folder, so it must
	// not become the key prefix the way WebDAV's does.
	it("leaves Dropbox on the bramble subfolder", () => {
		const cfg: BackupTargetConfig = { ...TARGET, provider: "dropbox", path: "Sub" };
		expect(backupPrefix(cfg)).toBe("bramble");
	});
});

describe("target keys", () => {
	it("namespaces a vault's target list", () => {
		expect(backupTargetsKeyFor("v1")).toBe("backup.targets:v1");
		expect(isBackupTargetsKey("backup.targets:v1")).toBe(true);
	});

	// The watcher must not treat the legacy device-global key as a vault's list.
	it("does not match the legacy device-global key", () => {
		expect(isBackupTargetsKey(BACKUP_TARGETS_KEY)).toBe(false);
		expect(isBackupTargetsKey("sync.group:v1")).toBe(false);
	});
});

describe("targetPrefixFor", () => {
	const webdav = (extra: Partial<BackupTargetConfig>): BackupTargetConfig => ({
		...TARGET,
		provider: "webdav",
		...extra,
	});

	// A target the user configured in this vault uses exactly the folder they typed, in every
	// vault: the list is per-vault now, so there is nothing to disambiguate (issue #49).
	it("uses the configured folder as-is for a vault's own target", () => {
		const cfg = webdav({ path: "/backups/passmanager/work" });
		expect(targetPrefixFor(cfg, "v2", false)).toBe("backups/passmanager/work");
	});

	// A target inherited from the old device-global list keeps writing where it already writes.
	it("keeps the derived per-vault folder for a shared (migrated) target", () => {
		const cfg = webdav({ path: "backups", sharedFolder: true });
		expect(targetPrefixFor(cfg, "v1", true)).toBe("backups");
		expect(targetPrefixFor(cfg, "v2", false)).toBe("backups-v2");
	});
});

describe("migrateBackupTargetsToVaults", () => {
	function store(initial: Record<string, unknown> = {}) {
		const data: Record<string, unknown> = { ...initial };
		const meta: BackupMetaStore = {
			getMeta: async <T>(key: string) => data[key] as T | undefined,
			setMeta: async (key, value) => {
				data[key] = value;
			},
			removeMeta: async (key) => {
				delete data[key];
			},
		};
		return { meta, data };
	}

	const shared: BackupTargetConfig[] = [{ ...TARGET, provider: "webdav", path: "backups" }];

	// Every vault adopts the old shared list, so the upgrade never silently stops backing one up.
	it("copies the device-global list to every vault and drops the global keys", async () => {
		const s = store({ [BACKUP_TARGETS_KEY]: shared });
		await migrateBackupTargetsToVaults(s.meta, ["v1", "v2"], () => "generated");
		const v1 = s.data[backupTargetsKeyFor("v1")] as BackupTargetConfig[];
		const v2 = s.data[backupTargetsKeyFor("v2")] as BackupTargetConfig[];
		expect(v1).toEqual([{ ...shared[0], sharedFolder: true }]);
		expect(v2).toEqual(v1);
		expect(s.data[BACKUP_TARGETS_KEY]).toBeUndefined();
		expect(s.data[BACKUP_CONFIG_KEY]).toBeUndefined();
	});

	it("folds the older single-target config in", async () => {
		const { id: _id, ...legacy } = shared[0] as BackupTargetConfig;
		const s = store({ [BACKUP_CONFIG_KEY]: legacy });
		await migrateBackupTargetsToVaults(s.meta, ["v1"], () => "generated");
		expect(s.data[backupTargetsKeyFor("v1")]).toEqual([
			{ ...legacy, id: "generated", sharedFolder: true },
		]);
		expect(s.data[BACKUP_CONFIG_KEY]).toBeUndefined();
	});

	// A vault that has already been configured owns its list; the migration must not clobber it.
	it("leaves a vault that already has its own list alone", async () => {
		const own: BackupTargetConfig[] = [{ ...TARGET, id: "own", provider: "s3" }];
		const s = store({ [BACKUP_TARGETS_KEY]: shared, [backupTargetsKeyFor("v1")]: own });
		await migrateBackupTargetsToVaults(s.meta, ["v1", "v2"], () => "generated");
		expect(s.data[backupTargetsKeyFor("v1")]).toEqual(own);
		expect(s.data[backupTargetsKeyFor("v2")]).toHaveLength(1);
	});

	// Before the registry resolves there is nothing to migrate onto: the global key must survive
	// so a later, id-aware run still finds it.
	it("no-ops (keeping the global key) when no vault is registered", async () => {
		const s = store({ [BACKUP_TARGETS_KEY]: shared });
		await migrateBackupTargetsToVaults(s.meta, [], () => "generated");
		expect(s.data[BACKUP_TARGETS_KEY]).toEqual(shared);
	});

	it("no-ops when there is nothing to migrate", async () => {
		const s = store({ [backupTargetsKeyFor("v1")]: [] });
		await migrateBackupTargetsToVaults(s.meta, ["v1"], () => "generated");
		expect(s.data).toEqual({ [backupTargetsKeyFor("v1")]: [] });
	});
});

describe("toProviderConfig", () => {
	it("does not bake the folder into the WebDAV base url", () => {
		const cfg: BackupTargetConfig = {
			...TARGET,
			provider: "webdav",
			serverUrl: "http://localhost:8080/remote.php/dav/files/admin/",
			path: "backups",
		};
		const out = toProviderConfig(cfg, { username: "admin", password: "pw" });
		expect(out).toEqual({
			kind: "webdav",
			serverUrl: "http://localhost:8080/remote.php/dav/files/admin/",
			username: "admin",
			password: "pw",
		});
	});
});

describe("normalizeS3", () => {
	it("passes a plain bucket + endpoint through", () => {
		expect(normalizeS3({ endpoint: "https://s3.example.com", bucket: "mybucket" })).toEqual({
			endpoint: "https://s3.example.com",
			bucket: "mybucket",
			prefix: undefined,
		});
	});

	it("splits a full URL pasted in the bucket field (R2 style)", () => {
		expect(
			normalizeS3({
				endpoint: "https://<account-id>.r2.cloudflarestorage.com",
				bucket: "https://abc123.r2.cloudflarestorage.com/bramble-backup-tests",
			}),
		).toEqual({
			endpoint: "https://abc123.r2.cloudflarestorage.com",
			bucket: "bramble-backup-tests",
			prefix: undefined,
		});
	});

	it("splits a full URL in the endpoint field, keeping extra path as prefix", () => {
		expect(
			normalizeS3({ endpoint: "https://host.example.com/mybucket/nested/dir", bucket: "" }),
		).toEqual({
			endpoint: "https://host.example.com",
			bucket: "mybucket",
			prefix: "nested/dir",
		});
	});

	it("strips a trailing slash from a bare endpoint", () => {
		expect(normalizeS3({ endpoint: "https://s3.example.com/", bucket: "b" })).toEqual({
			endpoint: "https://s3.example.com",
			bucket: "b",
			prefix: undefined,
		});
	});
});

describe("applyBackupOutcomes and the failure counter", () => {
	const NOW = 1_700_000_000_000;
	const base = { ...TARGET, id: "t1" } as BackupTargetConfig;
	const fold = (t: BackupTargetConfig, outcome: { hash?: string; error?: string }) =>
		applyBackupOutcomes([t], new Map([[t.id, outcome]]), NOW)[0] as BackupTargetConfig;

	it("counts consecutive failures and stamps when the last one was", () => {
		const once = fold(base, { error: "401" });
		expect(once).toMatchObject({ lastError: "401", failures: 1, failedAt: NOW });
		expect(fold(once, { error: "401" })).toMatchObject({ failures: 2, failedAt: NOW });
	});

	it("leaves the last-good stamps alone on failure", () => {
		const good = { ...base, lastBackupAt: 123, lastVaultHash: "H" };
		expect(fold(good, { error: "boom" })).toMatchObject({ lastBackupAt: 123, lastVaultHash: "H" });
	});

	it("a success clears the backoff as well as the error", () => {
		const failed = fold(fold(base, { error: "401" }), { error: "401" });
		expect(fold(failed, { hash: "NEW" })).toMatchObject({
			lastBackupAt: NOW,
			lastVaultHash: "NEW",
			lastError: undefined,
			failures: undefined,
			failedAt: undefined,
		});
	});

	it("does not touch a target with no outcome", () => {
		const other = { ...base, id: "t2" } as BackupTargetConfig;
		expect(applyBackupOutcomes([other], new Map([["t1", { error: "x" }]]), NOW)[0]).toBe(other);
	});

	// A skipped target (locked vault) records no outcome at all, so it must not accrue a backoff:
	// nothing is wrong with it, and backing it off would delay the run it is waiting for.
	it("a skip is not a failure", () => {
		expect(applyBackupOutcomes([base], new Map(), NOW)[0]?.failures).toBeUndefined();
	});
});

describe("clearBackoff", () => {
	it("drops the failure state so an edited target retries at once", () => {
		const t = { ...TARGET, failures: 5, failedAt: 1 } as BackupTargetConfig;
		expect(clearBackoff(t)).toMatchObject({ failures: undefined, failedAt: undefined });
	});

	it("keeps the error, which is still worth showing until the next attempt", () => {
		const t = { ...TARGET, failures: 1, failedAt: 1, lastError: "401" } as BackupTargetConfig;
		expect(clearBackoff(t).lastError).toBe("401");
	});

	it("returns the same object when there is nothing to clear", () => {
		const t = TARGET as BackupTargetConfig;
		expect(clearBackoff(t)).toBe(t);
	});
});
