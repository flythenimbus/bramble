import { describe, expect, it } from "vitest";
import {
	backupKey,
	runBackup,
	STALE_UPLOAD_MS,
	selectForPruning,
	selectStaleUploads,
	uploadTempKey,
} from "./orchestrator";
import { sha256Hex } from "./sigv4";
import { type BackupObject, type BackupTarget, readAll } from "./types";
import { bytesSource } from "./zip";

/** One backup of these bytes, fingerprinted the way a plain vault is. */
async function run(
	target: BackupTarget,
	bytes: Uint8Array,
	opts: Omit<Parameters<typeof runBackup>[2], "fingerprint"> = {},
) {
	return runBackup(target, bytesSource(bytes), { fingerprint: await sha256Hex(bytes), ...opts });
}

function mockTarget() {
	const store = new Map<string, Uint8Array>();
	const removed: string[] = [];
	const target: BackupTarget = {
		async put(key, body) {
			store.set(key, await readAll(body));
		},
		async get(key) {
			const v = store.get(key);
			if (!v) throw new Error("404");
			return v;
		},
		async list(prefix) {
			return [...store.entries()]
				.filter(([k]) => k.startsWith(prefix))
				.map(([k, v]): BackupObject => ({ key: k, size: v.byteLength }));
		},
		async remove(key) {
			store.delete(key);
			removed.push(key);
		},
	};
	return { target, store, removed };
}

describe("backup orchestrator", () => {
	it("builds a short, sortable object key", () => {
		expect(backupKey("bramble", "20260710T224759Z", "deadbeefcafe")).toBe(
			"bramble/bramble-20260710T224759Z-deadbeef.bramble",
		);
	});

	it("selects the oldest keys beyond keep for pruning", () => {
		const objs: BackupObject[] = [
			{ key: "bramble/bramble-20260101T000000Z-aaaaaaaa.bramble", size: 1 },
			{ key: "bramble/bramble-20260102T000000Z-bbbbbbbb.bramble", size: 1 },
			{ key: "bramble/bramble-20260103T000000Z-cccccccc.bramble", size: 1 },
		];
		expect(selectForPruning(objs, 2)).toEqual([
			"bramble/bramble-20260101T000000Z-aaaaaaaa.bramble",
		]);
		expect(selectForPruning(objs, 5)).toEqual([]);
	});

	it("tags a key with the vault it belongs to, still sorting chronologically", () => {
		const key = backupKey("bramble", "20260710T224759Z", "deadbeefcafe", "9f2c1a44-0000-4000");
		expect(key).toBe("bramble/bramble-20260710T224759Z-deadbeef-v9f2c1a44.bramble");
		// The stamp is still the first thing that varies, so lexical order stays chronological.
		const earlier = backupKey("bramble", "20260709T000000Z", "ffff", "9f2c1a44-0000-4000");
		expect([key, earlier].sort()).toEqual([earlier, key]);
	});

	// The data-loss case an adversarial review turned up: two vaults are allowed to point at the
	// same folder (the folder field is optional and defaults blank), and without scoping each
	// vault's prune counted the other's snapshots towards keep-N and deleted them.
	it("never prunes another vault's snapshots from a shared folder", () => {
		const objs: BackupObject[] = [
			{ key: "bramble/bramble-20260101T000000Z-aaaaaaaa-vaaaaaaaa.bramble", size: 1 },
			{ key: "bramble/bramble-20260102T000000Z-bbbbbbbb-vbbbbbbbb.bramble", size: 1 },
			{ key: "bramble/bramble-20260103T000000Z-cccccccc-vbbbbbbbb.bramble", size: 1 },
			{ key: "bramble/bramble-20260104T000000Z-dddddddd-vbbbbbbbb.bramble", size: 1 },
		];
		// Vault B is over its keep of 2, but vault A's lone (older) snapshot is not its to delete.
		expect(selectForPruning(objs, 2, "bbbbbbbb-0000-4000")).toEqual([
			"bramble/bramble-20260102T000000Z-bbbbbbbb-vbbbbbbbb.bramble",
		]);
		// And vault A, with one snapshot and keep 2, deletes nothing at all.
		expect(selectForPruning(objs, 2, "aaaaaaaa-0000-4000")).toEqual([]);
	});

	// Untagged keys are the legacy layout, where the folder already belonged to one vault. A
	// tagged run must leave them alone, and an untagged run must not sweep up tagged ones.
	it("keeps tagged and untagged snapshots in separate retention pools", () => {
		const objs: BackupObject[] = [
			{ key: "bramble/bramble-20260101T000000Z-aaaaaaaa.bramble", size: 1 },
			{ key: "bramble/bramble-20260102T000000Z-bbbbbbbb.bramble", size: 1 },
			{ key: "bramble/bramble-20260103T000000Z-cccccccc-vdddddddd.bramble", size: 1 },
		];
		expect(selectForPruning(objs, 1, "dddddddd-0000-4000")).toEqual([]);
		expect(selectForPruning(objs, 1)).toEqual([
			"bramble/bramble-20260101T000000Z-aaaaaaaa.bramble",
		]);
	});

	// Housekeeping must not fail a snapshot that is already safely uploaded: a target whose
	// listing is broken would otherwise never advance its hash and re-upload on every tick.
	it("keeps the backup when pruning fails", async () => {
		const { target, store } = mockTarget();
		target.list = async () => {
			throw new Error("listing denied");
		};
		const res = await run(target, new TextEncoder().encode("vault"), { keep: 1 });
		expect(store.size).toBe(1);
		expect(res.prunedKeys).toEqual([]);
		expect(res.hash).toHaveLength(64);
	});

	it("uploads a dated snapshot and keeps only the newest N", async () => {
		const { target, store } = mockTarget();
		for (let day = 1; day <= 4; day++) {
			await run(target, new TextEncoder().encode(`vault-${day}`), {
				keep: 2,
				now: new Date(Date.UTC(2026, 0, day)),
			});
		}
		const keys = [...store.keys()];
		expect(keys.length).toBe(2);
		expect(keys.every((k) => k.includes("20260103") || k.includes("20260104"))).toBe(true);
	});
});

// Deleting is the one thing Bramble asks a provider for that can lose the user something, and it
// exists only to serve keep-N. Giving that up is what lets someone hand over a credential that
// cannot destroy their backup history, so these pin the behaviour that makes it possible.
describe("append-only: keep everything", () => {
	it("prunes nothing at keep 0, rather than everything", () => {
		const objs: BackupObject[] = [1, 2, 3].map((n) => ({
			key: `bramble/bramble-2026010${n}T000000Z-aaaaaaaa.bramble`,
			size: 1,
		}));
		// `slice(0)` is every element: without the guard this deleted the lot, and 0 was only safe
		// because nothing could select it.
		expect(selectForPruning(objs, 0)).toEqual([]);
		expect(selectForPruning(objs, -1)).toEqual([]);
	});

	it("never lists or deletes, so a credential needs neither permission", async () => {
		const { target, store } = mockTarget();
		let listed = 0;
		let removed = 0;
		const watched: BackupTarget = {
			...target,
			list: async (p) => {
				listed++;
				return target.list(p);
			},
			remove: async (k) => {
				removed++;
				return target.remove(k);
			},
		};
		for (let i = 0; i < 3; i++) {
			await run(watched, new Uint8Array([i]), {
				keep: 0,
				now: new Date(Date.UTC(2026, 0, i + 1)),
			});
		}
		expect(listed).toBe(0);
		expect(removed).toBe(0);
		expect(store.size).toBe(3);
	});

	// The other half: a keep-N target whose credential refuses to delete still backs up. This is
	// what stops a scoped key looking like a broken target, and it is load-bearing for anyone who
	// tightens permissions without changing the setting.
	it("still succeeds when the provider refuses to delete", async () => {
		const { target, store } = mockTarget();
		const readOnly: BackupTarget = {
			...target,
			remove: async () => {
				throw new Error("403 AccessDenied");
			},
		};
		for (let i = 0; i < 3; i++) {
			await run(readOnly, new Uint8Array([i]), {
				keep: 1,
				now: new Date(Date.UTC(2026, 0, i + 1)),
			});
		}
		// Every upload landed and none of them threw, even though every prune was denied.
		expect(store.size).toBe(3);
	});

	it("still succeeds when the provider refuses to list", async () => {
		const { target, store } = mockTarget();
		const noList: BackupTarget = {
			...target,
			list: async () => {
				throw new Error("403 AccessDenied");
			},
		};
		const result = await run(noList, new Uint8Array([1]), { keep: 1 });
		expect(result.prunedKeys).toEqual([]);
		expect(store.size).toBe(1);
	});
});

// An upload is written aside and moved into place (see webdav.ts), so an app killed between the
// two leaves a temporary file behind. These pin that it is swept, and that nothing else is.
describe("abandoned upload temporaries", () => {
	const VAULT = "7c8cf540-0000-4000-8000-000000000000";
	const NOW = new Date("2026-09-26T12:00:00Z");
	const ago = (ms: number) => new Date(NOW.getTime() - ms).toUTCString();
	const snap = backupKey("b", "20260926T100000Z", "a".repeat(64), VAULT);

	it("names the temporary beside the snapshot, hidden, and invisible to pruning", () => {
		expect(uploadTempKey(snap)).toBe(`b/.${snap.slice(2)}.partial`);
		expect(uploadTempKey("x.bramble")).toBe(".x.bramble.partial");
		const objs: BackupObject[] = [{ key: uploadTempKey(snap), size: 1 }];
		expect(selectForPruning(objs, 1, VAULT)).toEqual([]);
	});

	it("sweeps only this vault's temporaries that are old enough to be abandoned", () => {
		const other = backupKey("b", "20260926T100000Z", "b".repeat(64), "deadbeef-0000");
		const objs: BackupObject[] = [
			{ key: uploadTempKey(snap), size: 1, lastModified: ago(STALE_UPLOAD_MS + 1000) },
			// Recent: another device's upload may still be in flight to this folder.
			{
				key: uploadTempKey(backupKey("b", "20260926T110000Z", "c".repeat(64), VAULT)),
				size: 1,
				lastModified: ago(60_000),
			},
			// Undated: its age cannot be known, so it is not judged.
			{ key: uploadTempKey(backupKey("b", "20260926T090000Z", "d".repeat(64), VAULT)), size: 1 },
			// Another vault's, however old.
			{ key: uploadTempKey(other), size: 1, lastModified: ago(STALE_UPLOAD_MS * 10) },
			// A real snapshot, however old, is never a temporary.
			{ key: snap, size: 1, lastModified: ago(STALE_UPLOAD_MS * 10) },
		];
		expect(selectStaleUploads(objs, NOW, VAULT)).toEqual([uploadTempKey(snap)]);
	});

	it("deletes them during a backup's prune", async () => {
		const removed: string[] = [];
		const stale = uploadTempKey(snap);
		const target: BackupTarget = {
			async put() {},
			async get() {
				return new Uint8Array();
			},
			async list() {
				return [{ key: stale, size: 1, lastModified: ago(STALE_UPLOAD_MS + 1000) }];
			},
			async remove(key) {
				removed.push(key);
			},
		};
		await run(target, new Uint8Array([1]), {
			prefix: "b",
			keep: 5,
			now: NOW,
			vaultId: VAULT,
		});
		expect(removed).toEqual([stale]);
	});
});

describe("sweeping uploads that never finished", () => {
	it("asks the target to sweep with this vault's own keys, and survives a failing sweep", async () => {
		const target = mockTarget().target;
		const own: ((key: string) => boolean)[] = [];
		const sweeping: BackupTarget = {
			...target,
			async sweepIncomplete(_prefix, _now, isOwn) {
				own.push(isOwn);
				throw new Error("ListMultipartUploads denied");
			},
		};
		const vaultId = "aaaaaaaa-1111-4222-8333-444444444444";
		await expect(run(sweeping, new Uint8Array([1]), { keep: 3, vaultId })).resolves.toBeDefined();
		expect(own).toHaveLength(1);
		expect(own[0]?.("bramble/bramble-20260101T000000Z-12345678-vaaaaaaaa.bramble")).toBe(true);
		expect(own[0]?.("bramble/bramble-20260101T000000Z-12345678-vbbbbbbbb.bramble")).toBe(false);
	});
});
