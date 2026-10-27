import type { FileSealer } from "@core/index";
import { fileRecord } from "@core/test/vault-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";

// What this file decides, pinned without a device: the order (decrypt, then arm the grace, then
// share), the paths Rust is given, and when decrypted copies are deleted.

const h = vi.hoisted(() => ({
	calls: [] as string[],
	rmdirs: [] as string[],
	shareError: null as Error | null,
	lockListener: null as ((locked: boolean) => void) | null,
	lastOpen: null as { srcPath: string; dstPath: string } | null,
	lastShare: null as { files?: string[]; title?: string } | null,
}));

vi.mock("@capacitor/filesystem", () => ({
	Directory: { Data: "DATA", Cache: "CACHE" },
	Filesystem: {
		// Percent-encoded, as Capacitor returns them: the reason paths are decoded for Rust.
		getUri: async ({ path, directory }: { path: string; directory: string }) => ({
			uri: `file:///${directory.toLowerCase()}/${encodeURI(path)}`,
		}),
		mkdir: async ({ path }: { path: string }) => {
			h.calls.push(`mkdir:${path.split("/")[0]}`);
		},
		rmdir: async ({ path, directory }: { path: string; directory: string }) => {
			h.rmdirs.push(`${directory}:${path}`);
		},
	},
}));
vi.mock("@capacitor/share", () => ({
	Share: {
		share: async (o: { files?: string[]; title?: string }) => {
			h.calls.push("share");
			h.lastShare = o;
			if (h.shareError) throw h.shareError;
		},
	},
}));
vi.mock("../auto-lock", () => ({
	armFilePickGrace: () => h.calls.push("grace"),
}));
vi.mock("../native-crypto", () => ({
	nativeFileCrypto: {
		openFileToPath: async (o: { srcPath: string; dstPath: string }) => {
			h.calls.push("decrypt");
			h.lastOpen = o;
			return { value: 10 };
		},
	},
}));
vi.mock("./vault-session", () => ({
	onVaultStateChange: (cb: (locked: boolean) => void) => {
		h.lockListener = cb;
		return () => {};
	},
}));

const { createMobilePresenter, startOpenedCopySweeps } = await import("./file-presenter");

const VAULT = "11111111-2222-4333-8444-555555555555";
const HASH = "a".repeat(64);
const record = fileRecord({ hash: HASH });
const sealerNamed = (name: string) =>
	({ describe: async () => ({ name, mime: "application/pdf" }) }) as unknown as FileSealer;

beforeEach(() => {
	h.calls = [];
	h.rmdirs = [];
	h.shareError = null;
	h.lastOpen = null;
	h.lastShare = null;
});

describe("createMobilePresenter", () => {
	// Grace before share, never after: the share sheet backgrounds the app, and an "Immediately"
	// auto-lock would otherwise sweep the copy before the chosen app has read it.
	it("decrypts, arms the auto-lock grace, then shares the copy", async () => {
		await createMobilePresenter(VAULT, sealerNamed("passport.pdf"))(record);
		expect(h.calls).toEqual(["mkdir:open", "decrypt", "grace", "share"]);
		expect(h.lastOpen?.srcPath).toBe(`/data/blobs/${VAULT}/${HASH}`);
		expect(h.lastOpen?.dstPath).toMatch(/^\/cache\/open\/[0-9a-f-]{36}\/passport\.pdf$/);
		expect(h.lastShare?.title).toBe("passport.pdf");
		expect(h.lastShare?.files?.[0]).toMatch(/^file:\/\/\/cache\/open\/.+\/passport\.pdf$/);
	});

	// Rust opens paths with std::fs. Handed the raw URI, it would write a file literally named
	// with %20 in it, and the share would then point at a file that does not exist.
	it("gives Rust a decoded path for a name with spaces", async () => {
		await createMobilePresenter(VAULT, sealerNamed("my scan 2.pdf"))(record);
		expect(h.lastOpen?.dstPath).toMatch(/\/my scan 2\.pdf$/);
	});

	it("keeps a slash in the name from becoming a folder", async () => {
		await createMobilePresenter(VAULT, sealerNamed("tax/2026.pdf"))(record);
		expect(h.lastOpen?.dstPath).toMatch(/\/open\/[0-9a-f-]{36}\/tax_2026\.pdf$/);
	});

	it("treats dismissing the share sheet as a choice, and anything else as an error", async () => {
		const present = createMobilePresenter(VAULT, sealerNamed("a.pdf"));
		h.shareError = new Error("Share canceled");
		await expect(present(record)).resolves.toBeUndefined();
		h.shareError = new Error("No Activity found to handle Intent");
		await expect(present(record)).rejects.toThrow(/No Activity/);
	});
});

describe("startOpenedCopySweeps", () => {
	// A decrypted copy must not outlive the session it was opened in.
	it("sweeps at start and on every lock, and not on unlock", async () => {
		startOpenedCopySweeps();
		await Promise.resolve();
		expect(h.rmdirs).toEqual(["CACHE:open"]);

		h.lockListener?.(false);
		await Promise.resolve();
		expect(h.rmdirs).toHaveLength(1);

		h.lockListener?.(true);
		await Promise.resolve();
		expect(h.rmdirs).toEqual(["CACHE:open", "CACHE:open"]);
	});
});
