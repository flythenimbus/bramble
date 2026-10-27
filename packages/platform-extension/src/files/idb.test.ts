import "fake-indexeddb/auto";
import { createBlobHasher, createBlobStore } from "@core/vault/blob-store";
import { describe, expect, it } from "vitest";
import {
	clearHandoffs,
	deleteVaultFiles,
	dropHandoff,
	idbBlobBackend,
	PART_LEN,
	publishStagedAs,
	putHandoff,
	readHandoff,
} from "./idb";

// The part arithmetic is where a file gets quietly corrupted: an append that does not top up a
// partial part, or a range read that is off by one at a boundary, still returns bytes. So every
// case here compares against the plain concatenation of what went in.

const vault = () => globalThis.crypto.randomUUID();
const bytes = (len: number, seed = 1) =>
	Uint8Array.from({ length: len }, (_, i) => (i * seed) % 251);

async function sha256(b: Uint8Array): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", b as BufferSource);
	return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

describe("idb blob backend", () => {
	it("keeps appends of any size contiguous across part boundaries", async () => {
		const backend = idbBlobBackend(vault());
		const sizes = [0, 10, PART_LEN - 10, 1, PART_LEN * 2 + 7, 3];
		const whole = new Uint8Array(sizes.reduce((a, n) => a + n, 0));
		let at = 0;
		for (const [i, n] of sizes.entries()) {
			const b = bytes(n, i + 2);
			await backend.appendStaged("k", b);
			whole.set(b, at);
			at += n;
		}
		expect(await backend.stagedSize("k")).toBe(whole.length);
		expect(await backend.readStaged("k", 0, whole.length)).toEqual(whole);
		// Ranges straddling each boundary, and one entirely inside a part.
		for (const [offset, len] of [
			[PART_LEN - 5, 10],
			[PART_LEN * 2 - 1, 2],
			[3, 50],
			[whole.length - 4, 4],
		] as const) {
			expect(await backend.readStaged("k", offset, len)).toEqual(whole.slice(offset, offset + len));
		}
	});

	it("refuses a read past the end", async () => {
		const backend = idbBlobBackend(vault());
		await backend.appendStaged("k", bytes(100));
		await expect(backend.readStaged("k", 90, 20)).rejects.toThrow(/past the end/);
	});

	it("publishes staging under a hash, lists it, and removes it with its parts", async () => {
		const v = vault();
		const backend = idbBlobBackend(v);
		const b = bytes(PART_LEN + 100);
		await backend.appendStaged("tok", b);
		await publishStagedAs(v, "tok", "a".repeat(64));
		expect(await backend.stagedSize("tok")).toBe(0);
		expect(await backend.has("a".repeat(64))).toBe(true);
		expect(await backend.size("a".repeat(64))).toBe(b.length);
		expect(await backend.read("a".repeat(64), 0, b.length)).toEqual(b);
		expect(await backend.list()).toEqual([{ hash: "a".repeat(64), size: b.length }]);

		await backend.remove("a".repeat(64));
		expect(await backend.has("a".repeat(64))).toBe(false);
		expect(await backend.list()).toEqual([]);
	});

	it("keeps the blob it already had when the same address is published again", async () => {
		const v = vault();
		const backend = idbBlobBackend(v);
		await backend.appendStaged("one", bytes(10, 3));
		await publishStagedAs(v, "one", "b".repeat(64));
		await backend.appendStaged("two", bytes(10, 3));
		await publishStagedAs(v, "two", "b".repeat(64));
		expect(await backend.stagedSize("two")).toBe(0);
		expect(await backend.read("b".repeat(64), 0, 10)).toEqual(bytes(10, 3));
	});

	// Per-vault stores are the reason a sweep of one vault cannot eat another's files.
	it("scopes every object to its vault, and deletes one vault's alone", async () => {
		const [a, b] = [vault(), vault()];
		await idbBlobBackend(a).appendStaged("x", bytes(5));
		await publishStagedAs(a, "x", "c".repeat(64));
		await idbBlobBackend(b).appendStaged("x", bytes(5));
		await publishStagedAs(b, "x", "c".repeat(64));
		await idbBlobBackend(b).appendStaged("pending", bytes(5));

		await deleteVaultFiles(b);
		expect(await idbBlobBackend(b).list()).toEqual([]);
		expect(await idbBlobBackend(b).stagedSize("pending")).toBe(0);
		expect(await idbBlobBackend(a).list()).toEqual([{ hash: "c".repeat(64), size: 5 }]);
	});
});

describe("BlobStore over IndexedDB", () => {
	it("verifies before publishing and resumes a staged prefix", async () => {
		const store = createBlobStore({
			backend: idbBlobBackend(vault()),
			createHasher: createBlobHasher,
		});
		const body = bytes(PART_LEN * 2 + 11, 7);
		const hash = await sha256(body);

		const first = await store.receive(hash);
		await first.append(body.subarray(0, PART_LEN + 3));
		// Interrupted here. A new receipt resumes from what was staged.
		const second = await store.receive(hash);
		expect(second.resumeFrom).toBe(PART_LEN + 3);
		await second.append(body.subarray(PART_LEN + 3));
		await second.commit();
		expect(await store.read(hash)).toEqual(body);

		const wrong = await store.receive("d".repeat(64));
		await wrong.append(bytes(10));
		await expect(wrong.commit()).rejects.toThrow(/mismatch/);
		expect(await store.has("d".repeat(64))).toBe(false);
	});
});

describe("plaintext handoff", () => {
	it("hands a Blob across by key and drops it", async () => {
		const token = await putHandoff(new Blob([bytes(40)]));
		const got = await readHandoff(token);
		expect(new Uint8Array(await (got as Blob).arrayBuffer())).toEqual(bytes(40));
		await dropHandoff(token);
		expect(await readHandoff(token)).toBeNull();
	});

	it("clears everything on a lock, and only stale entries by age", async () => {
		const fresh = await putHandoff(new Blob(["a"]));
		await clearHandoffs(60_000);
		expect(await readHandoff(fresh)).not.toBeNull();
		await clearHandoffs();
		expect(await readHandoff(fresh)).toBeNull();
	});
});
