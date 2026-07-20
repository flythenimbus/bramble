import { describe, expect, it } from "vitest";
import type { BackupTargetConfig } from "./config";
import { backupPrefix, normalizeS3, toProviderConfig } from "./config";

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
