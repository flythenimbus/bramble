import { describe, expect, it } from "vitest";
import { memoryBackend, realHasher, sha256Hex } from "../test/memory-blob-store";
import { type BlobBackend, createBlobStore } from "./blob-store";

const store = (backend: BlobBackend) => createBlobStore({ backend, createHasher: realHasher });
const body = (len: number, seed = 0) =>
	new Uint8Array(Array.from({ length: len }, (_, i) => (i * 7 + seed) % 251));

describe("createBlobStore", () => {
	it("puts, holds and reads back a blob", async () => {
		const { backend } = memoryBackend();
		const s = store(backend);
		const bytes = body(5000);
		const hash = await sha256Hex(bytes);
		await s.put(hash, bytes);
		expect(await s.has(hash)).toBe(true);
		expect(await s.size(hash)).toBe(5000);
		expect(await s.read(hash)).toEqual(bytes);
		expect(await s.list()).toEqual([hash]);
		expect(await s.totalBytes()).toBe(5000);
	});

	it("reads ranges, clamping past the end rather than failing", async () => {
		const { backend } = memoryBackend();
		const s = store(backend);
		const bytes = body(1000);
		const hash = await sha256Hex(bytes);
		await s.put(hash, bytes);
		expect(await s.read(hash, 100, 50)).toEqual(bytes.slice(100, 150));
		expect(await s.read(hash, 900)).toEqual(bytes.slice(900));
		// A peer asking for the tail should not need to know the exact length first.
		expect(await s.read(hash, 900, 999)).toEqual(bytes.slice(900));
		expect(await s.read(hash, 5000, 10)).toEqual(new Uint8Array(0));
		await expect(s.read(hash, -1)).rejects.toThrow(/negative/);
	});

	it("refuses to publish bytes that do not hash to their address", async () => {
		const { backend, blobs, staged } = memoryBackend();
		const s = store(backend);
		const hash = await sha256Hex(body(100));
		await expect(s.put(hash, body(100, 1))).rejects.toThrow(/hash mismatch/);
		expect(blobs.size).toBe(0);
		// Staging is discarded, not kept: a retry must not append to a poisoned prefix.
		expect(staged.size).toBe(0);
	});

	it("receives a blob in pieces", async () => {
		const { backend } = memoryBackend();
		const s = store(backend);
		const bytes = body(3000);
		const hash = await sha256Hex(bytes);
		const receipt = await s.receive(hash);
		expect(receipt.resumeFrom).toBe(0);
		expect(await receipt.append(bytes.slice(0, 1000))).toBe(1000);
		expect(await receipt.append(bytes.slice(1000))).toBe(3000);
		expect(await s.has(hash)).toBe(false); // nothing is visible before commit
		await receipt.commit();
		expect(await s.read(hash)).toEqual(bytes);
	});

	// The case that makes a large attachment survive a flaky link: the staged prefix outlives the
	// receipt (and the process), so a second receive picks up where the first stopped.
	it("resumes an interrupted receive from the staged prefix", async () => {
		const { backend } = memoryBackend();
		const s = store(backend);
		const bytes = body(9000);
		const hash = await sha256Hex(bytes);
		const first = await s.receive(hash);
		await first.append(bytes.slice(0, 4000));
		// The receipt (and its hasher) is simply dropped, as it would be on a restart.

		const second = await s.receive(hash);
		expect(second.resumeFrom).toBe(4000);
		await second.append(bytes.slice(4000));
		await second.commit();
		expect(await s.read(hash)).toEqual(bytes);
	});

	// The resume path rehashes the prefix rather than trusting it, so a staged prefix corrupted
	// at rest is caught at commit instead of being published under the right address.
	it("catches a corrupted staged prefix when resuming", async () => {
		const { backend, staged } = memoryBackend();
		const s = store(backend);
		const bytes = body(9000);
		const hash = await sha256Hex(bytes);
		const first = await s.receive(hash);
		await first.append(bytes.slice(0, 4000));

		const poisoned = new Uint8Array(staged.get(hash) as Uint8Array);
		poisoned[10] = (poisoned[10] ?? 0) ^ 0xff;
		staged.set(hash, poisoned);

		const second = await s.receive(hash);
		expect(second.resumeFrom).toBe(4000);
		await second.append(bytes.slice(4000));
		await expect(second.commit()).rejects.toThrow(/hash mismatch/);
	});

	it("rehashes a resumed prefix across many windows", async () => {
		// Larger than one REHASH_WINDOW, so the replay loop actually iterates.
		const { backend } = memoryBackend();
		const s = store(backend);
		const bytes = body(700 * 1024);
		const hash = await sha256Hex(bytes);
		const first = await s.receive(hash);
		await first.append(bytes.slice(0, 600 * 1024));
		const second = await s.receive(hash);
		expect(second.resumeFrom).toBe(600 * 1024);
		await second.append(bytes.slice(600 * 1024));
		await second.commit();
		expect(await s.read(hash)).toEqual(bytes);
	});

	it("aborting discards the staging", async () => {
		const { backend, staged } = memoryBackend();
		const s = store(backend);
		const bytes = body(500);
		const hash = await sha256Hex(bytes);
		const receipt = await s.receive(hash);
		await receipt.append(bytes);
		await receipt.abort();
		expect(staged.size).toBe(0);
		expect(await s.has(hash)).toBe(false);
	});

	it("closes a receipt after commit or abort", async () => {
		const { backend } = memoryBackend();
		const s = store(backend);
		const bytes = body(10);
		const hash = await sha256Hex(bytes);
		const receipt = await s.receive(hash);
		await receipt.append(bytes);
		await receipt.commit();
		await expect(receipt.append(bytes)).rejects.toThrow(/closed/);
		await expect(receipt.commit()).rejects.toThrow(/closed/);
	});

	it("refuses to receive a blob it already holds, and put is idempotent", async () => {
		const { backend } = memoryBackend();
		const s = store(backend);
		const bytes = body(64);
		const hash = await sha256Hex(bytes);
		await s.put(hash, bytes);
		await expect(s.receive(hash)).rejects.toThrow(/already held/);
		await s.put(hash, bytes); // content-addressed, so a second put is a no-op
		expect(await s.list()).toEqual([hash]);
	});

	it("deleting drops both the blob and any staging for it", async () => {
		const { backend, staged } = memoryBackend();
		const s = store(backend);
		const bytes = body(64);
		const hash = await sha256Hex(bytes);
		await s.put(hash, bytes);
		await backend.appendStaged(hash, bytes);
		await s.delete(hash);
		expect(await s.has(hash)).toBe(false);
		expect(staged.size).toBe(0);
	});

	it("sweeps everything not in the keep set", async () => {
		const { backend } = memoryBackend();
		const s = store(backend);
		const keep = body(100, 1);
		const drop = body(100, 2);
		const keepHash = await sha256Hex(keep);
		const dropHash = await sha256Hex(drop);
		await s.put(keepHash, keep);
		await s.put(dropHash, drop);
		expect(await s.sweep([keepHash])).toEqual([dropHash]);
		expect(await s.list()).toEqual([keepHash]);
		// Idempotent: a second sweep with the same keep set removes nothing more.
		expect(await s.sweep([keepHash])).toEqual([]);
	});

	// The hash is a filesystem key on the native backends, so anything not plain hex is a path.
	it("rejects a value that is not a blob hash", async () => {
		const { backend } = memoryBackend();
		const s = store(backend);
		for (const bad of ["../../etc/passwd", "A".repeat(64), "abc", `${"a".repeat(64)}/x`]) {
			await expect(s.has(bad)).rejects.toThrow(/not a blob hash/);
			await expect(s.receive(bad)).rejects.toThrow(/not a blob hash/);
			await expect(s.delete(bad)).rejects.toThrow(/not a blob hash/);
		}
	});

	it("round-trips an empty blob", async () => {
		const { backend } = memoryBackend();
		const s = store(backend);
		const hash = await sha256Hex(new Uint8Array(0));
		const receipt = await s.receive(hash);
		await receipt.commit();
		expect(await s.has(hash)).toBe(true);
		expect(await s.read(hash)).toEqual(new Uint8Array(0));
	});
});
