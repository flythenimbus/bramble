/** @vitest-environment happy-dom */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SyncBridge } from "./offscreen-core";

// The Chrome offscreen document hands peers' payloads to the background to merge. A merge that
// fails there has to fail here too: the session asks for the vault again only when it sees one,
// since peers no longer resend it every tick (docs/sync-rebroadcast.md).

const h = vi.hoisted(() => ({
	bridge: null as SyncBridge | null,
	answer: undefined as unknown,
}));

vi.mock("./offscreen-core", () => ({
	handleHostMessage: vi.fn(),
	setSyncBridge: (bridge: SyncBridge) => {
		h.bridge = bridge;
	},
}));

vi.mock("./platform-api", () => ({
	api: {
		runtime: {
			sendMessage: vi.fn(async () => h.answer),
			getURL: (path: string) => `chrome-extension://test/${path}`,
			onMessage: { addListener: () => {} },
		},
	},
}));

beforeAll(async () => {
	await import("./offscreen");
});

describe("the Chrome bridge's merges", () => {
	it("reject when the background says the merge failed", async () => {
		h.answer = { ok: false, error: "outer decrypt failed" };
		await expect(h.bridge!.pushRemotePayload("A", "{}")).rejects.toThrow("outer decrypt failed");
		await expect(h.bridge!.pushRemoteRoster("A", "{}")).rejects.toThrow("outer decrypt failed");
	});

	it("reject when nothing answers", async () => {
		h.answer = undefined;
		await expect(h.bridge!.pushRemotePayload("A", "{}")).rejects.toThrow("merge failed");
	});

	it("resolve when it merged, or had nothing to merge into", async () => {
		h.answer = { ok: true, data: true };
		await expect(h.bridge!.pushRemotePayload("A", "{}")).resolves.toBeUndefined();
		// A session for a vault no longer open is inert, not failing: no point asking again.
		h.answer = { ok: true, data: false };
		await expect(h.bridge!.pushRemotePayload("A", "{}")).resolves.toBeUndefined();
	});
});
