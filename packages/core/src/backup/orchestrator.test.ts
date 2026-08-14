import { describe, expect, it } from "vitest";
import { backupKey, runBackup, selectForPruning } from "./orchestrator";
import type { BackupObject, BackupTarget } from "./types";

function mockTarget() {
	const store = new Map<string, Uint8Array>();
	const removed: string[] = [];
	const target: BackupTarget = {
		async put(key, body) {
			store.set(key, body);
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
		const res = await runBackup(target, new TextEncoder().encode("vault"), { keep: 1 });
		expect(store.size).toBe(1);
		expect(res.prunedKeys).toEqual([]);
		expect(res.hash).toHaveLength(64);
	});

	it("uploads a dated snapshot and keeps only the newest N", async () => {
		const { target, store } = mockTarget();
		for (let day = 1; day <= 4; day++) {
			await runBackup(target, new TextEncoder().encode(`vault-${day}`), {
				keep: 2,
				now: new Date(Date.UTC(2026, 0, day)),
			});
		}
		const keys = [...store.keys()];
		expect(keys.length).toBe(2);
		expect(keys.every((k) => k.includes("20260103") || k.includes("20260104"))).toBe(true);
	});
});
