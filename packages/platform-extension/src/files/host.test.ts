import "fake-indexeddb/auto";
import { concat, sameBytes } from "@core/test/memory-blob-store";
import { describe, expect, it } from "vitest";
import {
	CHUNK_LEN,
	type FileWasm,
	type KdbxWasm,
	openToHandoff,
	saveKdbxToHandoff,
	sealFromHandoff,
} from "./host";
import { idbBlobBackend, putHandoff, readHandoff } from "./idb";

// The host's job is the loop around the wasm streams: feed the right chunks with the right final
// flag, stage and publish what comes out, and never touch the VEK after construction. The crypto
// itself is core-rust's and is checked against the real wasm in core-rust/verify.ts, so a
// reversible stand-in is enough here.

const TAG = 16;

function stubWasm(opts: { failOnChunk?: number } = {}) {
	const log: string[] = [];
	const fed: { len: number; last: boolean }[] = [];
	const wasm: FileWasm = {
		unlock_with_vek: (vek) => log.push(`vek:${vek}`),
		FileSealStream: class {
			size = 0;
			constructor(meta: string) {
				log.push(`seal:${meta}`);
			}
			seal_next(plain: Uint8Array, last: boolean) {
				if (opts.failOnChunk === fed.length) throw new Error("seal failed");
				fed.push({ len: plain.length, last });
				const out = new Uint8Array(plain.length + TAG);
				out.set(plain.map((b) => b ^ 0x5a));
				this.size += out.length;
				return out;
			}
			finish() {
				return {
					hash: "e".repeat(64),
					size: this.size,
					wrappedFek: "wf",
					fekIv: "fi",
					noncePrefix: "np",
					metaBlob: "mb",
					metaIv: "mi",
				};
			}
			free() {
				log.push("free");
			}
		},
		FileOpenStream: class {
			index = 0;
			count: number;
			constructor(
				_wf: string,
				_fi: string,
				_np: string,
				readonly sealedLen: number,
			) {
				log.push("open");
				this.count = Math.max(1, Math.ceil(sealedLen / (CHUNK_LEN + TAG)));
			}
			plaintext_len() {
				return this.sealedLen - this.count * TAG;
			}
			next_range() {
				if (this.index >= this.count) return undefined;
				const offset = this.index * (CHUNK_LEN + TAG);
				const len = this.index + 1 === this.count ? this.sealedLen - offset : CHUNK_LEN + TAG;
				return new Float64Array([offset, len]);
			}
			open_next(sealed: Uint8Array) {
				this.index++;
				return sealed.subarray(0, sealed.length - TAG).map((b) => b ^ 0x5a);
			}
			free() {
				log.push("free");
			}
		},
	};
	return { wasm, log, fed };
}

const body = (len: number) => Uint8Array.from({ length: len }, (_, i) => (i * 7) % 251);

describe("sealing from a handoff", () => {
	it("feeds whole chunks with the final flag on the last, then publishes under the hash", async () => {
		const vaultId = crypto.randomUUID();
		const { wasm, log, fed } = stubWasm();
		const plain = body(2 * CHUNK_LEN + 123);
		const handoff = await putHandoff(new Blob([plain]));

		const sealed = await sealFromHandoff(wasm, { vaultId, handoff, metaJson: "{m}", vekB64: "k1" });

		// The key goes in, the stream is built, and nothing asks for the key again.
		expect(log.slice(0, 2)).toEqual(["vek:k1", "seal:{m}"]);
		expect(log.filter((l) => l.startsWith("vek:"))).toHaveLength(1);
		expect(log.at(-1)).toBe("free");
		expect(fed).toEqual([
			{ len: CHUNK_LEN, last: false },
			{ len: CHUNK_LEN, last: false },
			{ len: 123, last: true },
		]);
		const backend = idbBlobBackend(vaultId);
		expect(await backend.list()).toEqual([{ hash: sealed.hash, size: plain.length + 3 * TAG }]);

		// And back out, as the download would receive it.
		const token = await openToHandoff(wasm, {
			vaultId,
			hash: sealed.hash,
			wrappedFek: "wf",
			fekIv: "fi",
			noncePrefix: "np",
			vekB64: "k1",
		});
		const out = (await readHandoff(token)) as Blob;
		expect(out.type).toBe("application/octet-stream");
		expect(new Uint8Array(await out.arrayBuffer())).toEqual(plain);
	});

	it("seals an empty file as one empty final chunk", async () => {
		const { wasm, fed } = stubWasm();
		const handoff = await putHandoff(new Blob([]));
		await sealFromHandoff(wasm, {
			vaultId: crypto.randomUUID(),
			handoff,
			metaJson: "{}",
			vekB64: "k",
		});
		expect(fed).toEqual([{ len: 0, last: true }]);
	});

	it("publishes nothing and frees the stream when sealing fails partway", async () => {
		const vaultId = crypto.randomUUID();
		const { wasm, log } = stubWasm({ failOnChunk: 1 });
		const handoff = await putHandoff(new Blob([body(CHUNK_LEN + 5)]));
		await expect(
			sealFromHandoff(wasm, { vaultId, handoff, metaJson: "{}", vekB64: "k" }),
		).rejects.toThrow("seal failed");
		expect(log.at(-1)).toBe("free");
		expect(await idbBlobBackend(vaultId).list()).toEqual([]);
	});

	it("refuses a handoff that is gone", async () => {
		const { wasm } = stubWasm();
		await expect(
			sealFromHandoff(wasm, {
				vaultId: crypto.randomUUID(),
				handoff: "missing",
				metaJson: "{}",
				vekB64: "k",
			}),
		).rejects.toThrow(/no longer staged/);
	});
});

describe("opening to a handoff", () => {
	it("says so when this device does not hold the file", async () => {
		const { wasm, log } = stubWasm();
		await expect(
			openToHandoff(wasm, {
				vaultId: crypto.randomUUID(),
				hash: "f".repeat(64),
				wrappedFek: "wf",
				fekIv: "fi",
				noncePrefix: "np",
				vekB64: "k",
			}),
		).rejects.toThrow(/isn't on this device/);
		// Checked before the key is loaded.
		expect(log).toEqual([]);
	});
});

/** The stub streams plus a KeePass writer that records what it was handed: each attachment's
 * declared length and bytes, and the entries it was finished with. Its "file" is a header,
 * then the attachments' bytes as written, then a footer, so the handoff can be checked whole. */
function stubKdbx() {
	const base = stubWasm();
	const written: { declared: number; bytes: Uint8Array[] }[] = [];
	let finishedWith: unknown = null;
	const reads: string[] = [];
	const wasm: KdbxWasm = {
		...base.wasm,
		KdbxWriter: class {
			pending: Uint8Array[] = [new TextEncoder().encode("HEAD")];
			constructor(password: string) {
				base.log.push(`writer:${password}`);
			}
			begin_binary(len: number) {
				written.push({ declared: len, bytes: [] });
				return written.length - 1;
			}
			write_binary(bytes: Uint8Array) {
				written.at(-1)?.bytes.push(bytes.slice());
				this.pending.push(bytes.slice());
			}
			take() {
				const out = concat(this.pending);
				this.pending = [];
				return out;
			}
			finish(entries: unknown) {
				finishedWith = entries;
				return new TextEncoder().encode("TAIL");
			}
			free() {
				base.log.push("writer-free");
			}
		},
	};
	return { wasm, log: base.log, written, reads, finished: () => finishedWith };
}

/** Store `plain` under `hash` in the form the stub open stream reverses: each chunk XORed and
 * followed by a tag. Returns the record fields an export is handed. */
async function plant(vaultId: string, hash: string, plain: Uint8Array, name: string, entry = 0) {
	const backend = idbBlobBackend(vaultId);
	const chunks = Math.max(1, Math.ceil(plain.length / CHUNK_LEN));
	for (let i = 0; i < chunks; i++) {
		const part = plain.subarray(i * CHUNK_LEN, (i + 1) * CHUNK_LEN);
		const sealed = new Uint8Array(part.length + TAG);
		sealed.set(part.map((b) => b ^ 0x5a));
		await backend.appendStaged(hash, sealed);
	}
	await backend.publishStaged(hash);
	return {
		entry,
		hash,
		size: plain.length + chunks * TAG,
		wrappedFek: "wf",
		fekIv: "fi",
		noncePrefix: "np",
		name,
	};
}

describe("a KeePass export", () => {
	it("writes every attachment whole, by the name it is given, on its own entry", async () => {
		const vaultId = crypto.randomUUID();
		const one = body(CHUNK_LEN + 500);
		const two = body(77).map((b) => b ^ 1);
		const files = [
			await plant(vaultId, "a".repeat(64), one, "scan.pdf"),
			await plant(vaultId, "b".repeat(64), two, "scan (2).pdf"),
		];
		const k = stubKdbx();

		const token = await saveKdbxToHandoff(k.wasm, {
			vaultId,
			vekB64: "k1",
			password: "pw",
			entries: [{ strings: [{ key: "Title", value: "Passport", protected: false }] }],
			files,
		});

		expect(k.written.map((w) => w.declared)).toEqual([one.length, two.length]);
		expect(sameBytes(concat(k.written[0]?.bytes ?? []), one)).toBe(true);
		expect(sameBytes(concat(k.written[1]?.bytes ?? []), two)).toBe(true);
		expect(k.finished()).toEqual([
			{
				strings: [{ key: "Title", value: "Passport", protected: false }],
				binaries: [
					{ name: "scan.pdf", index: 0 },
					{ name: "scan (2).pdf", index: 1 },
				],
			},
		]);
		const file = new Uint8Array(await ((await readHandoff(token)) as Blob).arrayBuffer());
		const te = new TextEncoder();
		expect(sameBytes(file, concat([te.encode("HEAD"), one, two, te.encode("TAIL")]))).toBe(true);
		// The key went in once, before any stream needed it; everything was freed.
		expect(k.log.filter((l) => l.startsWith("vek:"))).toEqual(["vek:k1"]);
		expect(k.log.at(-1)).toBe("writer-free");
	});

	it("writes nothing when an attachment hasn't reached this device", async () => {
		const vaultId = crypto.randomUUID();
		const k = stubKdbx();
		await expect(
			saveKdbxToHandoff(k.wasm, {
				vaultId,
				vekB64: "k1",
				password: "pw",
				entries: [{ strings: [] }],
				files: [
					{
						entry: 0,
						hash: "c".repeat(64),
						size: 100,
						wrappedFek: "wf",
						fekIv: "fi",
						noncePrefix: "np",
						name: "m",
					},
				],
			}),
		).rejects.toThrow(/hasn't reached this device/);
		// Refused before the writer was even made: no half file, nothing derived.
		expect(k.log.some((l) => l.startsWith("writer:"))).toBe(false);
	});
});
