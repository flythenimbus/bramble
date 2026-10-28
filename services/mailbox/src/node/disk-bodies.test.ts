import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@vault/core/src/sync/mailbox/protocol.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BodyStore, HashMismatchError } from "../core/bodies.ts";
import { diskBodies } from "./disk-bodies.ts";

const bytesOf = async (body: ReadableStream<Uint8Array>) =>
	new Uint8Array(await new Response(body).arrayBuffer());
const streamOf = (bytes: Uint8Array) =>
	new Response(bytes as Uint8Array<ArrayBuffer>).body as ReadableStream<Uint8Array>;

describe("diskBodies", () => {
	let root: string;
	let store: BodyStore;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "mailbox-bodies-"));
		store = diskBodies(root);
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("round-trips a streamed body and reports its size", async () => {
		// getRandomValues fills at most 64 KiB per call.
		const big = new Uint8Array(3 * 1024 * 1024 - 7);
		for (let i = 0; i < big.length; i += 65536) crypto.getRandomValues(big.subarray(i, i + 65536));
		await store.put("b/mbx/one", streamOf(big), { sha256: await sha256Hex(big) });
		const got = await store.get("b/mbx/one");
		expect(got?.size).toBe(big.length);
		// Buffer.compare: toEqual walks a 3 MiB array element by element, about 4 s.
		expect(Buffer.compare(Buffer.from(await bytesOf(got!.body)), Buffer.from(big))).toBe(0);
	});

	it("leaves nothing behind when the hash does not match", async () => {
		await expect(
			store.put("b/mbx/two", new Uint8Array([1, 2, 3]), { sha256: "0".repeat(64) }),
		).rejects.toBeInstanceOf(HashMismatchError);
		expect(await store.get("b/mbx/two")).toBeNull();
		const files = await readdir(root, { recursive: true, withFileTypes: true });
		expect(files.filter((f) => f.isFile())).toEqual([]);
	});

	it("treats deleting a missing key as done", async () => {
		await expect(store.delete("m/mbx/gone")).resolves.toBeUndefined();
	});

	it("lists keys with their modification times", async () => {
		await store.put("m/mbx/a", new Uint8Array([1]));
		await store.put("b/mbx/c", new Uint8Array([2]));
		const keys = [];
		for await (const k of store.keys()) keys.push(k);
		expect(keys.map((k) => k.key).sort()).toEqual(["b/mbx/c", "m/mbx/a"]);
		expect(keys.every((k) => k.modifiedAt > 0)).toBe(true);
	});

	it("refuses a key that would leave the root", async () => {
		await expect(store.put("m/../escape", new Uint8Array([1]))).rejects.toThrow();
		await expect(store.get("m/mbx/../../x")).rejects.toThrow();
		const files = await readdir(join(root, ".."));
		expect(files).not.toContain("escape");
	});
});
