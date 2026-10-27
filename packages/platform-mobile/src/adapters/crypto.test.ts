import { fileRecord } from "@core/test/vault-fixtures";
import { bytesToBase64 } from "@core/util/bytes";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The KeePass export's marshalling on a phone: each attachment goes to the native core as its
// blob file's path, never as bytes, and the database comes back as a path to share.

const h = vi.hoisted(() => ({
	saves: [] as { entriesJson: string; password: string; filesJson: string; outPath: string }[],
	fail: false,
	released: 0,
}));

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock("@capacitor/filesystem", () => ({
	Directory: { Data: "DATA" },
	Filesystem: { getUri: async ({ path }: { path: string }) => ({ uri: `file:///data/${path}` }) },
}));
vi.mock("../native-crypto", () => ({
	loadNativeCrypto: async () => ({}),
	newKdbxFolder: async () => ({
		path: "/cache/open/kdbx-1",
		release: async () => {
			h.released++;
		},
	}),
	nativeFileCrypto: {
		saveKdbx4: async (o: (typeof h.saves)[number]) => {
			h.saves.push(o);
			if (h.fail) throw new Error("an attachment hasn't reached this device yet");
			return { value: 2048 };
		},
		readFileRange: async () => ({ value: bytesToBase64(new Uint8Array([3, 217])) }),
	},
}));
vi.mock("../wasm-loader", () => ({ loadWasm: async () => ({}) }));
vi.mock("./vault-session", () => ({
	markLocked: () => {},
	markUnlocked: () => {},
	onExternalChange: () => () => {},
	onExternalLock: () => () => {},
}));

const { mobileCrypto } = await import("./crypto");

const VAULT = "11111111-2222-4333-8444-555555555555";
const record = fileRecord({ hash: "a".repeat(64) });
const input = {
	vaultId: VAULT,
	name: "bramble-vault-2026-10-02.kdbx",
	entries: [{ strings: [] }],
	password: "pw",
	files: [{ entry: 0, record, name: "scan.pdf" }],
};

beforeEach(() => {
	h.saves = [];
	h.fail = false;
	h.released = 0;
});

describe("mobile KeePass export", () => {
	it("writes the database natively from blob paths, and hands back its path", async () => {
		const saved = await mobileCrypto.saveKdbx?.(input);

		expect(h.saves).toHaveLength(1);
		expect(h.saves[0]?.outPath).toBe("/cache/open/kdbx-1/bramble-vault-2026-10-02.kdbx");
		expect(JSON.parse(h.saves[0]?.entriesJson ?? "")).toEqual([{ strings: [] }]);
		expect(JSON.parse(h.saves[0]?.filesJson ?? "")).toEqual([
			{
				blobPath: `/data/blobs/${VAULT}/${record.hash}`,
				wrappedFek: record.wrappedFek,
				fekIv: record.fekIv,
				noncePrefix: record.noncePrefix,
				size: record.size,
				entry: 0,
				name: "scan.pdf",
			},
		]);
		expect(saved?.size).toBe(2048);
		expect(saved?.path).toBe("/cache/open/kdbx-1/bramble-vault-2026-10-02.kdbx");
		expect(await saved?.read(0, 2)).toEqual(new Uint8Array([3, 217]));
		expect(h.released).toBe(0);
		await saved?.release?.();
		expect(h.released).toBe(1);
	});

	it("leaves nothing behind when the native writer refuses", async () => {
		h.fail = true;
		await expect(mobileCrypto.saveKdbx?.(input)).rejects.toThrow(/hasn't reached this device/);
		expect(h.released).toBe(1);
	});
});
