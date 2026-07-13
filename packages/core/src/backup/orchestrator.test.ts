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
