import { base64ToBytes, bytesToBase64 } from "@core/util/bytes";
import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory native filesystem: path -> base64 data, plus the set of directories. Enough of
// Capacitor's Filesystem to exercise the backend's paths without a device.
const { files, dirs } = vi.hoisted(() => ({
	files: new Map<string, string>(),
	dirs: new Set<string>(),
}));

vi.mock("@capacitor/filesystem", () => ({
	Directory: { Data: "DATA" },
	Filesystem: {
		mkdir: async ({ path }: { path: string }) => {
			dirs.add(path);
		},
		stat: async ({ path }: { path: string }) => {
			const data = files.get(path);
			if (data === undefined) throw new Error("not found");
			return { type: "file", size: base64ToBytes(data).length };
		},
		appendFile: async ({ path, data }: { path: string; data: string }) => {
			const prev = files.get(path);
			const joined = prev
				? new Uint8Array([...base64ToBytes(prev), ...base64ToBytes(data)])
				: base64ToBytes(data);
			files.set(path, bytesToBase64(joined));
		},
		readFile: async ({ path }: { path: string }) => ({ data: files.get(path) }),
		rename: async ({ from, to }: { from: string; to: string }) => {
			const data = files.get(from);
			if (data === undefined) throw new Error("not found");
			files.set(to, data);
			files.delete(from);
		},
		deleteFile: async ({ path }: { path: string }) => {
			if (!files.delete(path)) throw new Error("not found");
		},
		rmdir: async ({ path }: { path: string }) => {
			for (const key of [...files.keys()]) if (key.startsWith(`${path}/`)) files.delete(key);
			dirs.delete(path);
		},
		readdir: async ({ path }: { path: string }) => ({
			files: [...files.entries()]
				.filter(([key]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/"))
				.map(([key, data]) => ({
					name: key.slice(path.length + 1),
					type: "file",
					size: base64ToBytes(data).length,
				})),
		}),
		getUri: async ({ path }: { path: string }) => ({ uri: `file:///data/${path}` }),
	},
}));

// The native ranged read, over the same in-memory files: getUri above maps a path to
// `file:///data/<path>`, so the path the plugin is handed maps straight back.
const rangeReads = vi.hoisted(() => [] as { offset: number; length: number }[]);
vi.mock("../native-crypto", () => ({
	nativeFileCrypto: {
		readFileRange: async ({
			path,
			offset,
			length,
		}: {
			path: string;
			offset: number;
			length: number;
		}) => {
			rangeReads.push({ offset, length });
			const data = files.get(path.replace(/^\/data\//, ""));
			if (data === undefined) throw new Error("not found");
			return { value: bytesToBase64(base64ToBytes(data).slice(offset, offset + length)) };
		},
	},
}));

const { blobDirFor, createMobileBlobBackend, deleteMobileVaultBlobs } = await import(
	"./blob-store"
);

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const hash = (c: string) => c.repeat(64);

beforeEach(() => {
	files.clear();
	dirs.clear();
});

async function hold(vaultId: string, h: string, bytes: number[]) {
	const backend = createMobileBlobBackend(vaultId);
	await backend.appendStaged(h, new Uint8Array(bytes));
	await backend.publishStaged(h);
	return backend;
}

describe("blobDirFor", () => {
	it("gives each vault its own folder", () => {
		expect(blobDirFor(A)).toBe(`blobs/${A}`);
		expect(blobDirFor(B)).not.toBe(blobDirFor(A));
	});

	// The id becomes a path segment, so anything that could climb out of blobs/ is refused
	// before it reaches the filesystem.
	it("refuses an id that is not a single safe path segment", () => {
		for (const bad of ["", "..", "../other", "a/b", "a\\b", ".hidden", "x".repeat(65), "a b"]) {
			expect(() => blobDirFor(bad)).toThrow();
		}
	});
});

describe("createMobileBlobBackend is scoped to one vault", () => {
	it("writes under that vault's folder", async () => {
		await hold(A, hash("a"), [1, 2, 3]);
		expect([...files.keys()]).toEqual([`blobs/${A}/${hash("a")}`]);
	});

	it("lists, reads and removes only its own vault's files", async () => {
		await hold(A, hash("a"), [1]);
		const b = await hold(B, hash("b"), [2]);

		expect((await b.list()).map((x) => x.hash)).toEqual([hash("b")]);
		expect(await b.has(hash("a"))).toBe(false);

		// A remove from B can never reach A's file, even by guessing its hash.
		await b.remove(hash("a"));
		expect(files.has(`blobs/${A}/${hash("a")}`)).toBe(true);
	});

	it("keeps staging inside the vault's folder, and out of the listing", async () => {
		const backend = createMobileBlobBackend(A);
		await backend.appendStaged(hash("c"), new Uint8Array([9]));
		expect(files.has(`blobs/${A}/.staging-${hash("c")}`)).toBe(true);
		expect(await backend.list()).toEqual([]);
		expect(await backend.reserveStagingPath?.("tok")).toBe(`/data/blobs/${A}/.staging-tok`);
	});
});

describe("deleteMobileVaultBlobs", () => {
	it("erases one vault's folder and leaves the others", async () => {
		await hold(A, hash("a"), [1]);
		await hold(B, hash("b"), [2]);
		await deleteMobileVaultBlobs(A);
		expect([...files.keys()]).toEqual([`blobs/${B}/${hash("b")}`]);
	});

	it("is fine for a vault that never had attachments", async () => {
		await expect(deleteMobileVaultBlobs(A)).resolves.toBeUndefined();
	});
});

describe("pathFromUri", () => {
	it("strips the scheme and decodes, so Rust gets the real name", async () => {
		const { pathFromUri } = await import("./paths");
		expect(pathFromUri("file:///data/blobs/x/abc")).toBe("/data/blobs/x/abc");
		expect(pathFromUri("file:///var/Library/Caches/open/u/my%20scan.pdf")).toBe(
			"/var/Library/Caches/open/u/my scan.pdf",
		);
	});

	// iOS gives a path that does not exist yet a trailing slash, as for a folder; a file about
	// to be written there must not be opened as one.
	it("drops the trailing slash iOS puts on a path that does not exist yet", async () => {
		const { pathFromUri } = await import("./paths");
		expect(pathFromUri("file:///var/Documents/blobs/v/.staging-t/")).toBe(
			"/var/Documents/blobs/v/.staging-t",
		);
		expect(pathFromUri("file:///")).toBe("/");
	});

	it("is undone by uriFromPath, for the share sheet", async () => {
		const { pathFromUri, uriFromPath } = await import("./paths");
		const path = "/var/Library/Caches/open/kdbx-1/my vault #1.kdbx";
		expect(uriFromPath(path)).toBe("file:///var/Library/Caches/open/kdbx-1/my%20vault%20%231.kdbx");
		expect(pathFromUri(uriFromPath(path))).toBe(path);
	});
});

describe("ranged reads", () => {
	// Capacitor's Filesystem reads whole files; a blob read in parts must not cost a whole read
	// per part, so the range goes to the native side as asked.
	it("reads exactly the range asked for, natively", async () => {
		const backend = createMobileBlobBackend(A);
		const bytes = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
		await backend.appendStaged("k", bytes);
		rangeReads.length = 0;
		expect(await backend.readStaged("k", 100, 50)).toEqual(bytes.slice(100, 150));
		expect(rangeReads).toEqual([{ offset: 100, length: 50 }]);
	});

	it("refuses a short read rather than return fewer bytes than asked", async () => {
		const backend = createMobileBlobBackend(A);
		await backend.appendStaged("short", new Uint8Array(10));
		await expect(backend.readStaged("short", 5, 20)).rejects.toThrow(/shorter/);
	});
});
