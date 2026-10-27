import { fileRecord } from "@core/test/vault-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The webview half of desktop attachments. What is pinned is the marshalling, since that is
// what decides whether a file's bytes stay out of this webview: a pick is a path, a seal is a
// path, and the only bytes that cross do so raw rather than as JSON number arrays.

const h = vi.hoisted(() => ({
	calls: [] as { cmd: string; args: unknown; options?: { headers?: Record<string, string> } }[],
	replies: {} as Record<string, unknown>,
	lockListener: null as ((locked: boolean) => void) | null,
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: async (cmd: string, args: unknown, options?: { headers?: Record<string, string> }) => {
		h.calls.push({ cmd, args, options });
		return h.replies[cmd];
	},
}));
vi.mock("./vault-session", () => ({
	onVaultStateChange: (cb: (locked: boolean) => void) => {
		h.lockListener = cb;
		return () => {};
	},
}));

const { desktopFiles, startOpenedCopySweeps } = await import("./files");

const VAULT = "11111111-2222-4333-8444-555555555555";
const HASH = "a".repeat(64);
const record = fileRecord({ hash: HASH });

beforeEach(() => {
	h.calls = [];
	h.replies = {};
});

const call = (cmd: string) => {
	const found = h.calls.find((c) => c.cmd === cmd);
	if (!found) throw new Error(`no ${cmd} call; saw ${h.calls.map((c) => c.cmd).join(", ")}`);
	return found;
};

describe("desktop pick and seal", () => {
	// A path, never a Blob: the file is sealed from disk in the shell.
	it("picks a path, with its size so the core can refuse an oversized file", async () => {
		h.replies.files_pick = { path: "/Users/me/tax 2026.pdf", name: "tax 2026.pdf", size: 1234 };
		const picked = await desktopFiles.forVault(VAULT).pick?.();
		expect(picked).toEqual({
			source: { kind: "path", path: "/Users/me/tax 2026.pdf", size: 1234 },
			name: "tax 2026.pdf",
			mime: "application/pdf",
		});
	});

	it("returns null when the dialog is cancelled", async () => {
		h.replies.files_pick = null;
		expect(await desktopFiles.forVault(VAULT).pick?.()).toBeNull();
	});

	it("seals by path, and refuses a source whose bytes are already in the webview", async () => {
		h.replies.files_seal = { hash: HASH };
		const { sealer } = desktopFiles.forVault(VAULT);
		await sealer.seal(
			{ kind: "path", path: "/tmp/a.pdf" },
			{ name: "a.pdf", mime: "application/pdf" },
		);
		const args = call("files_seal").args as Record<string, unknown>;
		expect(args.vaultId).toBe(VAULT);
		expect(args.srcPath).toBe("/tmp/a.pdf");
		expect(JSON.parse(args.metaJson as string)).toEqual({ name: "a.pdf", mime: "application/pdf" });

		await expect(
			sealer.seal({ kind: "blob", blob: new Blob(["x"]) }, { name: "a", mime: "b" }),
		).rejects.toThrow(/seals from a path/);
	});
});

describe("desktop blob store marshalling", () => {
	// Raw both ways. As number arrays, restoring or backing up a 90 MB attachment would be several
	// hundred megabytes of JSON.
	it("appends raw bytes, with the vault and key in headers", async () => {
		const { blobs } = desktopFiles.forVault(VAULT);
		h.replies.files_has = false;
		h.replies.files_staged_size = 0;
		const receipt = await blobs.receive(HASH);
		await receipt.append(new Uint8Array([1, 2, 3]));
		const appends = h.calls.filter((c) => c.cmd === "files_append_staged");
		const last = appends[appends.length - 1];
		expect(last?.args).toEqual(new Uint8Array([1, 2, 3]));
		expect(last?.options?.headers).toEqual({ "x-vault-id": VAULT, "x-key": HASH });
	});

	it("reads blob bytes back from a raw response", async () => {
		const { blobs } = desktopFiles.forVault(VAULT);
		h.replies.files_size = 3;
		h.replies.files_read = new Uint8Array([7, 8, 9]).buffer;
		expect(await blobs.read(HASH)).toEqual(new Uint8Array([7, 8, 9]));
	});
});

describe("desktop open", () => {
	it("opens with the sealed name, decrypted and opened in the shell", async () => {
		h.replies.files_open_meta = JSON.stringify({ name: "passport.pdf", mime: "application/pdf" });
		await desktopFiles.forVault(VAULT).present?.(record);
		const args = call("files_open").args as Record<string, unknown>;
		expect(args).toMatchObject({
			vaultId: VAULT,
			hash: HASH,
			name: "passport.pdf",
			noncePrefix: "np",
		});
		expect(args.token).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("sweeps decrypted copies at start and on every lock, not on unlock", () => {
		startOpenedCopySweeps();
		const sweeps = () => h.calls.filter((c) => c.cmd === "files_sweep_opened").length;
		expect(sweeps()).toBe(1);
		h.lockListener?.(false);
		expect(sweeps()).toBe(1);
		h.lockListener?.(true);
		expect(sweeps()).toBe(2);
	});

	it("deletes a vault's attachments by its id", async () => {
		await desktopFiles.deleteVault(VAULT);
		expect(call("files_delete_vault").args).toEqual({ vaultId: VAULT });
	});
});
