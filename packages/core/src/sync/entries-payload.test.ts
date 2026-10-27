import { describe, expect, it } from "vitest";
import { fileRecord } from "../test/vault-fixtures";
import type { EncryptedEntry } from "../vault-format";
import {
	decodeEntriesPayload,
	type EntriesPayload,
	emptyEntriesPayload,
	encodeEntriesPayload,
	type FileRecord,
	sanitizeRemoteEntriesPayload,
} from "./entries-payload";
import { HLC_MAX_DRIFT_MS } from "./hlc";

const entry = (id: string, wall: number): EncryptedEntry => ({
	id,
	wrappedDek: "wd",
	dekIv: "di",
	ciphertext: "ct",
	iv: "iv",
	hlc: { wall, counter: 0, node: "dev" },
});

describe("entries payload codec", () => {
	it("round-trips entries and tombstones", () => {
		const payload: EntriesPayload = {
			entries: [entry("a", 100), entry("b", 200)],
			tombstones: [{ id: "c", hlc: { wall: 300, counter: 1, node: "dev" } }],
		};
		expect(decodeEntriesPayload(encodeEntriesPayload(payload))).toEqual(payload);
	});

	it("round-trips an empty payload", () => {
		expect(decodeEntriesPayload(encodeEntriesPayload(emptyEntriesPayload()))).toEqual({
			entries: [],
			tombstones: [],
		});
	});

	it("rejects the legacy bare-array shape", () => {
		expect(() => decodeEntriesPayload(JSON.stringify([entry("a", 1)]))).toThrow();
	});

	it("rejects an entry missing its hlc stamp", () => {
		const bad = JSON.stringify({
			entries: [{ id: "a", wrappedDek: "w", dekIv: "d", ciphertext: "c", iv: "i" }],
			tombstones: [],
		});
		expect(() => decodeEntriesPayload(bad)).toThrow();
	});

	it("rejects a payload missing the tombstones field", () => {
		expect(() => decodeEntriesPayload(JSON.stringify({ entries: [] }))).toThrow();
	});

	it("vv, floor and conflicts round-trip through encode and decode", () => {
		const stamp = { wall: 100, counter: 0, node: "dev" };
		const payload: EntriesPayload = {
			entries: [
				{ ...entry("a", 100), vv: { dev: stamp }, floor: { wall: 50, counter: 0, node: "old" } },
			],
			tombstones: [{ id: "c", hlc: stamp, vv: { dev: stamp } }],
			conflicts: [{ ...entry("a", 90), vv: { other: { wall: 90, counter: 0, node: "other" } } }],
		};
		expect(decodeEntriesPayload(encodeEntriesPayload(payload))).toEqual(payload);
	});

	it("a payload without them still parses and encodes without adding keys", () => {
		const json = encodeEntriesPayload({
			entries: [entry("a", 100)],
			tombstones: [{ id: "c", hlc: { wall: 300, counter: 1, node: "dev" } }],
		});
		expect(json).not.toContain('"vv"');
		expect(json).not.toContain('"floor"');
		expect(json).not.toContain('"conflicts"');
	});
});

describe("sanitizeRemoteEntriesPayload", () => {
	const now = 1_000_000;
	const future = { wall: now + HLC_MAX_DRIFT_MS + 1, counter: 0, node: "x" };
	const ok = { wall: now, counter: 0, node: "dev" };

	it("drops a conflict or tombstone with a future floor or vv component", () => {
		const safe = sanitizeRemoteEntriesPayload(
			{
				entries: [{ ...entry("a", now), vv: { dev: ok } }],
				tombstones: [
					{ id: "t1", hlc: ok, vv: { dev: ok, x: future } },
					{ id: "t2", hlc: ok, floor: future, vv: { dev: ok } },
					{ id: "t3", hlc: ok },
				],
				conflicts: [
					{ ...entry("a", now - 1), vv: { dev: ok }, floor: future },
					{ ...entry("a", now - 2), vv: { y: { ...ok, node: "y" }, x: future } },
					{ ...entry("a", now - 3), vv: { z: { wall: now - 3, counter: 0, node: "z" } } },
				],
			},
			now,
		);
		expect(safe.entries.map((e) => e.id)).toEqual(["a"]);
		expect(safe.tombstones.map((t) => t.id)).toEqual(["t3"]);
		expect(safe.conflicts?.map((e) => e.hlc.wall)).toEqual([now - 3]);
	});

	it("leaves conflicts absent when it was absent", () => {
		const safe = sanitizeRemoteEntriesPayload({ entries: [], tombstones: [] }, now);
		expect("conflicts" in safe).toBe(false);
	});
});

const HASH = "0123456789abcdef".repeat(4);

const fileRec = (id: string, wall: number): FileRecord =>
	fileRecord({ id, hlc: { wall, counter: 0, node: "dev" }, hash: HASH, size: 262160 });

describe("file manifest codec", () => {
	it("round-trips files, file tombstones, marks and an entryId", () => {
		const payload: EntriesPayload = {
			entries: [entry("a", 100)],
			tombstones: [],
			files: [fileRec("f1", 100), { ...fileRec("f2", 200), entryId: "a" }],
			fileTombstones: [{ id: "f3", hlc: { wall: 300, counter: 0, node: "dev" } }],
			fileCascades: [{ id: "f2", hlc: { wall: 400, counter: 0, node: "dev" } }],
		};
		expect(decodeEntriesPayload(encodeEntriesPayload(payload))).toEqual(payload);
	});

	it("still parses a payload written before the manifest existed", () => {
		const legacy = JSON.stringify({ entries: [entry("a", 100)], tombstones: [] });
		const parsed = decodeEntriesPayload(legacy);
		expect(parsed.files).toBeUndefined();
		expect(parsed.fileTombstones).toBeUndefined();
	});

	// The hash doubles as the blob's filename on the mobile and desktop stores, so a value that
	// is not plain lowercase hex is a path, not a name.
	it("rejects a hash that is not lowercase hex sha-256", () => {
		for (const hash of [
			HASH.toUpperCase(),
			"../../etc/passwd",
			`${HASH}a`,
			HASH.slice(0, 63),
			"a+/b",
		]) {
			expect(() =>
				encodeEntriesPayload({
					entries: [],
					tombstones: [],
					files: [{ ...fileRec("f", 1), hash }],
				}),
			).toThrow();
		}
	});

	it("rejects a negative or fractional size", () => {
		for (const size of [-1, 1.5]) {
			expect(() =>
				encodeEntriesPayload({
					entries: [],
					tombstones: [],
					files: [{ ...fileRec("f", 1), size }],
				}),
			).toThrow();
		}
	});

	it("drops future-stamped files, file tombstones and marks from a remote payload", () => {
		const now = 1_000_000;
		const far = { wall: now + 5 * 24 * 3600_000, counter: 0, node: "evil" };
		const safe = sanitizeRemoteEntriesPayload(
			{
				entries: [],
				tombstones: [],
				files: [fileRec("ok", now - 1000), { ...fileRec("evil", 0), hlc: far }],
				fileTombstones: [
					{ id: "ok-t", hlc: { wall: now - 1000, counter: 0, node: "dev" } },
					{ id: "evil-t", hlc: far },
				],
				fileCascades: [
					{ id: "ok-c", hlc: { wall: now - 1000, counter: 0, node: "dev" } },
					{ id: "evil-c", hlc: far },
				],
			},
			now,
		);
		expect(safe.files?.map((f) => f.id)).toEqual(["ok"]);
		expect(safe.fileTombstones?.map((t) => t.id)).toEqual(["ok-t"]);
		expect(safe.fileCascades?.map((t) => t.id)).toEqual(["ok-c"]);
	});
});
