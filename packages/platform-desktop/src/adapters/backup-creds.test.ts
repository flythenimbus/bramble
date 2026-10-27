import type { BackupTargetConfig } from "@core/backup/config";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A backup body crosses to the shell raw. As a JSON number array, an archive of a vault with its
// attachments (up to MAX_BACKUP_BYTES) would be several hundred megabytes of JSON.

const h = vi.hoisted(() => ({
	calls: [] as { cmd: string; args: unknown; options?: { headers?: Record<string, string> } }[],
	failWrite: false,
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: async (cmd: string, args: unknown, options?: { headers?: Record<string, string> }) => {
		h.calls.push({ cmd, args, options });
		if (cmd === "backup_stream_open") return 7;
		if (cmd === "stream_write" && h.failWrite) throw new Error("disk full");
		return { status: 201, body: [] };
	},
}));

const { desktopBackupCreds } = await import("./backup-creds");

const target = {
	id: "t1",
	provider: "webdav",
	serverUrl: "https://dav.example/",
	frequency: "daily",
	keep: 3,
	creds: { wrap: "os" },
} as unknown as BackupTargetConfig;

beforeEach(() => {
	h.calls = [];
	h.failWrite = false;
});

/** What the shell would decode from the request header. */
function decodeParams(header: string): Record<string, unknown> {
	const binary = atob(header);
	const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
	return JSON.parse(new TextDecoder().decode(bytes));
}

describe("desktop backup transport", () => {
	it("sends a body as raw bytes, with the rest of the request in one header", async () => {
		const body = new Uint8Array([0x50, 0x4b, 3, 4, 9, 9]);
		const res = await desktopBackupCreds.transport?.("v1", target).send({
			method: "PUT",
			url: "https://dav.example/bramble/bramble-x.bramble",
			headers: { "content-type": "application/octet-stream" },
			body,
		});
		expect(res?.status).toBe(201);
		const [only] = h.calls;
		expect(only?.cmd).toBe("backup_send_raw");
		expect(only?.args).toBe(body);
		const params = decodeParams(only?.options?.headers?.["x-bramble-request"] as string);
		expect(params).toMatchObject({
			vaultId: "v1",
			targetId: "t1",
			method: "PUT",
			url: "https://dav.example/bramble/bramble-x.bramble",
			headers: { "content-type": "application/octet-stream" },
			auth: { kind: "basic" },
		});
	});

	// A header must be ASCII, and a folder name need not be: hence base64 over UTF-8.
	it("carries a non-ASCII URL through the header intact", async () => {
		await desktopBackupCreds.transport?.("v1", target).send({
			method: "PUT",
			url: "https://dav.example/Sauvegardes Été/x.bramble",
			body: new Uint8Array([1]),
		});
		const header = h.calls[0]?.options?.headers?.["x-bramble-request"] as string;
		expect(/^[A-Za-z0-9+/=]+$/.test(header)).toBe(true);
		expect(decodeParams(header).url).toBe("https://dav.example/Sauvegardes Été/x.bramble");
	});

	it("keeps a bodiless request on the plain JSON path", async () => {
		await desktopBackupCreds.transport?.("v1", target).send({
			method: "PROPFIND",
			url: "https://dav.example/bramble/",
		});
		expect(h.calls[0]?.cmd).toBe("backup_send");
		expect(h.calls[0]?.args).toMatchObject({ vaultId: "v1", method: "PROPFIND", body: null });
	});

	// A WebDAV backup too large for one IPC call: the shell opens the request with the secret,
	// the body follows in raw chunks, and nothing of it is ever one buffer here.
	it("streams a body source through the shell in raw chunks", async () => {
		const size = 9 * 1024 * 1024;
		const res = await desktopBackupCreds.transport?.("v1", target).send({
			method: "PUT",
			url: "https://dav.example/x.bramble",
			body: { size, read: async (_o, l) => new Uint8Array(l) },
		});
		expect(res?.status).toBe(201);
		const cmds = h.calls.map((c) => c.cmd);
		expect(cmds[0]).toBe("backup_stream_open");
		expect(h.calls[0]?.args).toMatchObject({ vaultId: "v1", method: "PUT", size });
		const writes = h.calls.filter((c) => c.cmd === "stream_write");
		expect(writes.length).toBe(3);
		expect(writes.every((w) => w.options?.headers?.["x-stream-id"] === "7")).toBe(true);
		expect(writes.reduce((n, w) => n + (w.args as Uint8Array).length, 0)).toBe(size);
		expect(cmds[cmds.length - 1]).toBe("stream_finish");
	});

	it("aborts the stream when a chunk cannot be written", async () => {
		h.failWrite = true;
		await expect(
			desktopBackupCreds.transport?.("v1", target).send({
				method: "PUT",
				url: "https://dav.example/x.bramble",
				body: { size: 10, read: async (_o, l) => new Uint8Array(l) },
			}),
		).rejects.toThrow("disk full");
		expect(h.calls.map((c) => c.cmd)).toContain("stream_abort");
		expect(h.calls.map((c) => c.cmd)).not.toContain("stream_finish");
	});
});
