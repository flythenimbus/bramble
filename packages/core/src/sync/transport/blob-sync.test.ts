import { describe, expect, it, vi } from "vitest";
import { memoryBlobStore, sameBytes, sha256Hex } from "../../test/memory-blob-store";
import { peerPipe, rosterOf, sourceFor, testBlobSession } from "../../test/transport-fakes";
import type { BlobStore } from "../../vault/blob-store";
import {
	type BlobSyncOptions,
	type StatusSnapshot,
	statusOf,
	type WantedBlob,
	WINDOW,
} from "./blob-sync";
import type { PeerSession } from "./mesh";
import type { PeerSource } from "./peer-session";

// What has to hold: a file moves only on request, arrives whole and verified, resumes where it
// was cut off, is refused if its bytes are wrong, and is never served to a revoked device.
// Driven over an in-memory pipe (a PeerSource), so no relay, ICE or WebRTC is involved; the
// WebRTC-only rule for the mesh path is pinned in mesh-webrtc-only.test.ts.

const bytes = (len: number, seed: number) =>
	Uint8Array.from({ length: len }, (_, i) => (i * seed + (i >> 10)) % 251);

async function sealedFile(len: number, seed: number) {
	const body = bytes(len, seed);
	return { body, hash: await sha256Hex(body), size: len };
}

const start = (
	pub: string,
	peer: PeerSession,
	blobs: BlobStore,
	wanted: WantedBlob[],
	extra: Partial<BlobSyncOptions> = {},
) => testBlobSession(pub, sourceFor(peer).source, blobs, wanted, extra);

describe("blob sync", () => {
	it("pulls a missing file in windows, whole and verified", async () => {
		const file = await sealedFile(2 * WINDOW + 777, 7);
		const holder = memoryBlobStore().store;
		await holder.put(file.hash, file.body);
		const fetcher = memoryBlobStore().store;
		const received: string[] = [];
		const link = peerPipe();

		const a = await start("aaaa", link.a, holder, [file]);
		const b = await start("bbbb", link.b, fetcher, [file], {
			onReceived: (h) => received.push(h),
		});
		await vi.waitFor(() => expect(received).toEqual([file.hash]), { timeout: 10_000 });
		expect(sameBytes(await fetcher.read(file.hash), file.body)).toBe(true);
		a.stop();
		b.stop();
	});

	it("fetches nothing the vault does not name", async () => {
		const file = await sealedFile(1000, 3);
		const holder = memoryBlobStore().store;
		await holder.put(file.hash, file.body);
		const fetcher = memoryBlobStore().store;
		const link = peerPipe();
		const a = await start("aaaa", link.a, holder, [file]);
		// b's manifest names nothing: a file it was never told about is not its to fetch.
		const b = await start("bbbb", link.b, fetcher, []);
		await new Promise((r) => setTimeout(r, 200));
		expect(await fetcher.has(file.hash)).toBe(false);
		a.stop();
		b.stop();
	});

	// A peer holding the wrong bytes under a hash (corrupt, or hostile) can cost a retry. It can
	// never cost the vault a wrong file, because nothing is stored until it hashes to its name.
	it("refuses a file whose bytes do not hash to its name", async () => {
		const file = await sealedFile(5000, 11);
		const backend = memoryBlobStore();
		// Plant wrong bytes under the right name, beneath the store's own checks.
		await backend.backend.appendStaged(file.hash, bytes(5000, 99));
		await backend.backend.publishStaged(file.hash);
		const fetcher = memoryBlobStore().store;
		const reports: string[] = [];
		const link = peerPipe();
		const a = await start("aaaa", link.a, backend.store, [file]);
		const b = await start("bbbb", link.b, fetcher, [file], { report: (s) => reports.push(s) });
		await vi.waitFor(() => expect(reports.some((r) => r.includes("rejected"))).toBe(true), {
			timeout: 10_000,
		});
		expect(await fetcher.has(file.hash)).toBe(false);
		a.stop();
		b.stop();
	});

	it("resumes from what a cut-off transfer already staged", async () => {
		const file = await sealedFile(3 * WINDOW, 5);
		const holder = memoryBlobStore().store;
		await holder.put(file.hash, file.body);
		const fetcher = memoryBlobStore();
		// Half of it arrived before the connection dropped.
		await fetcher.backend.appendStaged(file.hash, file.body.subarray(0, WINDOW + 10));
		const wants: number[] = [];
		const link = peerPipe();
		const a = await start("aaaa", link.a, holder, [file]);
		const send = link.b.channel.send;
		link.b.channel.send = (d: string) => {
			if (d.includes('"t":"want"')) wants.push(JSON.parse(d).o);
			send(d);
		};
		const b = await start("bbbb", link.b, fetcher.store, [file]);
		await vi.waitFor(async () => expect(await fetcher.store.has(file.hash)).toBe(true), {
			timeout: 10_000,
		});
		expect(wants[0]).toBe(WINDOW + 10);
		expect(sameBytes(await fetcher.store.read(file.hash), file.body)).toBe(true);
		a.stop();
		b.stop();
	});

	it("serves nothing to a device revoked mid-session", async () => {
		const file = await sealedFile(4000, 13);
		const holder = memoryBlobStore().store;
		await holder.put(file.hash, file.body);
		const fetcher = memoryBlobStore().store;
		let revoked = false;
		const link = peerPipe();
		const a = await start("aaaa", link.a, holder, [file], {
			// The holder learns of the revocation after the session was set up.
			fetchLocalRoster: async () => JSON.stringify(rosterOf(revoked ? ["aaaa"] : ["aaaa", "bbbb"])),
		});
		revoked = true;
		const b = await start("bbbb", link.b, fetcher, [file]);
		await new Promise((r) => setTimeout(r, 300));
		expect(await fetcher.has(file.hash)).toBe(false);
		a.stop();
		b.stop();
	});

	// A file attached after both sessions started is announced and fetched without a restart.
	it("picks up a file that arrives on the holder later", async () => {
		const file = await sealedFile(3000, 19);
		const holder = memoryBlobStore().store;
		const fetcher = memoryBlobStore().store;
		const link = peerPipe();
		const a = await start("aaaa", link.a, holder, [file]);
		const b = await start("bbbb", link.b, fetcher, [file]);
		await new Promise((r) => setTimeout(r, 100));
		expect(await fetcher.has(file.hash)).toBe(false);
		await holder.put(file.hash, file.body);
		a.poke();
		await vi.waitFor(async () => expect(await fetcher.has(file.hash)).toBe(true), {
			timeout: 10_000,
		});
		a.stop();
		b.stop();
	});
});

describe("statusOf", () => {
	const H = "a".repeat(64);
	const base: StatusSnapshot = {
		now: 1000,
		active: null,
		peers: [],
		passOver: new Map(),
		unreachable: false,
		linkOnly: false,
		label: (pub) => (pub === "aaaa" ? "Laptop" : null),
	};
	const holding = { pub: "aaaa", has: new Set([H]) };
	const without = { pub: "aaaa", has: new Set<string>() };

	it("is downloading, from whom and how far, while the file comes in", () => {
		const active = { hash: H, from: "aaaa", received: 40, size: 100 };
		expect(statusOf(H, { ...base, active, peers: [holding] })).toEqual({
			state: "downloading",
			from: "Laptop",
			received: 40,
			size: 100,
		});
	});

	it("is queued while a connected device has it and another file is coming in", () => {
		const active = { hash: "b".repeat(64), from: "aaaa", received: 0, size: 1 };
		expect(statusOf(H, { ...base, active, peers: [holding] })).toEqual({
			state: "queued",
			from: "Laptop",
		});
	});

	it("is retrying while every device that has it is passed over after a failed transfer", () => {
		const passOver = new Map([[`aaaa:${H}`, 5000]]);
		expect(statusOf(H, { ...base, peers: [holding], passOver })).toEqual({
			state: "retrying",
			from: "Laptop",
		});
	});

	it("names no device it can't put a name to", () => {
		expect(statusOf(H, { ...base, peers: [{ pub: "zzzz", has: new Set([H]) }] })).toEqual({
			state: "queued",
			from: null,
		});
	});

	it("puts a device it can't reach ahead of connected ones without the file", () => {
		expect(statusOf(H, { ...base, peers: [without], unreachable: true })).toEqual({
			state: "unreachable",
		});
		expect(statusOf(H, { ...base, peers: [without] })).toEqual({ state: "not-on-connected" });
	});

	it("points a device with no WebRTC at the desktop app, and otherwise just waits", () => {
		expect(statusOf(H, { ...base, linkOnly: true })).toEqual({ state: "desktop-only" });
		expect(statusOf(H, base)).toEqual({ state: "waiting" });
	});
});

describe("a session's status", () => {
	it("says a connected device lacks the file, then leaves the file out once it is here", async () => {
		const file = await sealedFile(1000, 3);
		const holder = memoryBlobStore().store;
		const fetcher = memoryBlobStore().store;
		const link = peerPipe();
		const a = await start("aaaa", link.a, holder, []);
		const b = await start("bbbb", link.b, fetcher, [file]);
		await vi.waitFor(async () =>
			expect(await b.status([file.hash])).toEqual({ [file.hash]: { state: "not-on-connected" } }),
		);
		await holder.put(file.hash, file.body);
		a.poke();
		await vi.waitFor(async () => expect(await b.status([file.hash])).toEqual({}), {
			timeout: 10_000,
		});
		a.stop();
		b.stop();
	});

	it("with no WebRTC and nothing connected, points at the desktop app", async () => {
		const file = await sealedFile(1000, 3);
		const idle: PeerSource = async () => ({ stop() {} });
		const alone = await testBlobSession("bbbb", idle, memoryBlobStore().store, [file]);
		expect(await alone.status([file.hash])).toEqual({ [file.hash]: { state: "desktop-only" } });
		alone.stop();
	});
});
