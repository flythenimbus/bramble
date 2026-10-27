/** @vitest-environment happy-dom */
import { act, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { BackupActivityAdapter } from "../adapters/backup-activity";
import { type BackupTargetConfig, backupTargetsKeyFor } from "../backup/config";
import type { Platform } from "../context/PlatformContext";
import { mountBackup } from "../test/vault-harness";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";

// Mobile backs up on unlock and on resume, from outside React. Before this, that run was invisible
// on the settings screen: no "Backing up", a "Back up now" button that could start a second upload
// of the same target alongside it, and a result that only appeared after reopening the screen.

afterEach(cleanup);

const VAULT = "11111111-2222-4333-8444-555555555555";
const target = {
	id: "t1",
	providerId: "s3",
	provider: "s3",
	frequency: "daily",
	keep: 30,
	creds: { iv: "IV", ciphertext: "CT" },
} as unknown as BackupTargetConfig;

function makePlatform() {
	let push: (ids: ReadonlySet<string>) => void = () => {};
	const activity: BackupActivityAdapter = {
		subscribe(cb) {
			push = cb;
			cb(new Set());
			return () => {};
		},
	};
	const metaSubs = new Map<string, () => void>();
	const store = new Map<string, unknown>([
		[VAULT_REGISTRY_KEY, { vaults: [{ id: VAULT, label: "", createdAt: 1 }] }],
		[backupTargetsKeyFor(VAULT), [target]],
	]);
	const platform = {
		storage: {
			getMeta: vi.fn(async (k: string) => store.get(k)),
			setMeta: vi.fn(async (k: string, v: unknown) => void store.set(k, v)),
			removeMeta: vi.fn(async () => {}),
			subscribeMeta: (k: string, cb: () => void) => {
				metaSubs.set(k, cb);
				return () => metaSubs.delete(k);
			},
		},
		crypto: {},
		shell: {},
		backupActivity: activity,
	} as unknown as Platform;
	return { platform, store, metaSubs, push: (ids: string[]) => push(new Set(ids)) };
}

it("shows a backup started elsewhere as running, and stops when it ends", async () => {
	const p = makePlatform();
	const hook = mountBackup(p.platform);
	await act(async () => {});
	expect(hook.current?.runningIds.has("t1")).toBe(false);

	act(() => p.push(["t1"]));
	expect(hook.current?.runningIds.has("t1")).toBe(true);

	act(() => p.push([]));
	expect(hook.current?.runningIds.has("t1")).toBe(false);
});

it("picks up a result written outside the screen without being reopened", async () => {
	const p = makePlatform();
	const hook = mountBackup(p.platform);
	await act(async () => {});
	expect(hook.current?.targets?.[0]?.lastBackupAt).toBeUndefined();

	// The automatic run records its outcome, as the mobile runner does through storage.
	p.store.set(backupTargetsKeyFor(VAULT), [{ ...target, lastBackupAt: 123 }]);
	await act(async () => p.metaSubs.get(backupTargetsKeyFor(VAULT))?.());
	expect(hook.current?.targets?.[0]?.lastBackupAt).toBe(123);
});
