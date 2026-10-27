import "fake-indexeddb/auto";
import { fileRecord } from "@core/test/vault-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { putHandoff, readHandoff } from "./files/idb";

// The view's half: the file's bytes go into IndexedDB and only a key is messaged, and the
// plaintext parked there is dropped however the operation ends.

const h = vi.hoisted(() => ({
	calls: [] as {
		type: string;
		payload: Record<string, unknown>;
		vaultId?: string;
		timeout?: number;
	}[],
	onSeal: null as null | ((payload: Record<string, unknown>) => Promise<unknown>),
	openedHandoff: "",
}));

vi.mock("./crypto", () => ({
	FILE_OP_TIMEOUT_MS: 300_000,
	dispatch: async (
		type: string,
		payload: Record<string, unknown>,
		vaultId?: string,
		timeout?: number,
	) => {
		h.calls.push({ type, payload, vaultId, timeout });
		if (type === "CRYPTO_FILE_SEAL") return h.onSeal?.(payload);
		if (type === "CRYPTO_FILE_META")
			return JSON.stringify({ name: "passport.pdf", mime: "application/pdf" });
		if (type === "CRYPTO_FILE_OPEN") return h.openedHandoff;
		throw new Error(`unexpected ${type}`);
	},
}));

const { extensionFiles } = await import("./files");

const VAULT = "v1";
const record = fileRecord({ size: 10 });

beforeEach(() => {
	h.calls = [];
	h.onSeal = null;
});

describe("extension sealing", () => {
	it("parks the file, messages only its key, and drops it once sealed", async () => {
		let parked: Blob | null = null;
		h.onSeal = async (p) => {
			parked = await readHandoff(p.handoff as string);
			return { hash: "a".repeat(64) };
		};
		await extensionFiles
			.forVault(VAULT)
			.sealer.seal(
				{ kind: "blob", blob: new Blob(["secret"]) },
				{ name: "a.txt", mime: "text/plain" },
			);

		const [call] = h.calls;
		expect(call?.type).toBe("CRYPTO_FILE_SEAL");
		expect(call?.vaultId).toBe(VAULT);
		expect(Object.keys(call?.payload ?? {}).sort()).toEqual(["handoff", "metaJson"]);
		expect(JSON.parse(call?.payload.metaJson as string)).toEqual({
			name: "a.txt",
			mime: "text/plain",
		});
		expect(call?.timeout).toBeGreaterThan(30_000);
		expect(await (parked as unknown as Blob).text()).toBe("secret");
		expect(await readHandoff(call?.payload.handoff as string)).toBeNull();
	});

	it("drops the parked file when sealing fails", async () => {
		h.onSeal = async () => {
			throw new Error("host failed");
		};
		await expect(
			extensionFiles
				.forVault(VAULT)
				.sealer.seal({ kind: "bytes", bytes: new Uint8Array([1, 2]) }, { name: "b", mime: "x" }),
		).rejects.toThrow("host failed");
		expect(await readHandoff(h.calls[0]?.payload.handoff as string)).toBeNull();
	});
});

describe("extension open", () => {
	it("downloads under the sealed name and drops the decrypted copy", async () => {
		h.openedHandoff = await putHandoff(new Blob(["plain"], { type: "application/octet-stream" }));
		const anchor = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
		vi.stubGlobal("document", {
			createElement: () => anchor,
			body: { appendChild: vi.fn() },
		});
		const created = vi.spyOn(URL, "createObjectURL");
		const revoked = vi.spyOn(URL, "revokeObjectURL");

		await extensionFiles.forVault(VAULT).present?.(record);

		expect(h.calls.find((c) => c.type === "CRYPTO_FILE_OPEN")?.payload).toEqual({
			hash: record.hash,
			wrappedFek: "wf",
			fekIv: "fi",
			noncePrefix: "np",
		});
		expect(anchor.download).toBe("passport.pdf");
		expect(anchor.click).toHaveBeenCalledOnce();
		expect(revoked).toHaveBeenCalledWith(created.mock.results[0]?.value);
		expect(await readHandoff(h.openedHandoff)).toBeNull();
		vi.unstubAllGlobals();
	});
});
