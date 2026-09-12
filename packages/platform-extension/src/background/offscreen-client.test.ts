import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncBridge } from "../offscreen-core";

const host = vi.hoisted(() => ({
	loads: 0,
	fail: false,
	setSyncBridge: vi.fn(),
	handleHostMessage: vi.fn(async () => ({ ok: true, data: "done" })),
}));
vi.mock("./vek-store", () => ({ vekMutationSnapshot: () => 0 }));

const bridge: SyncBridge = {
	fetchLocalPayload: async () => "payload",
	pushRemotePayload: async () => {},
	fetchLocalRoster: async () => "roster",
	pushRemoteRoster: async () => {},
};

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	host.loads = 0;
	host.fail = false;
	vi.doMock("../offscreen-core", () => {
		host.loads++;
		if (host.fail) throw new Error("host chunk failed to load");
		return { setSyncBridge: host.setSyncBridge, handleHostMessage: host.handleHostMessage };
	});

	vi.stubGlobal("chrome", { runtime: {} });
});
afterEach(() => vi.unstubAllGlobals());

describe("lazy in-process sync host", () => {
	it("registers the bridge before dispatch, without loading the host at registration", async () => {
		const client = await import("./offscreen-client");
		client.setInProcessSyncBridge(bridge);
		expect(host.loads).toBe(0);
		await expect(client.sendToOffscreen({ type: "SYNC_ROSTER_SYNC" })).resolves.toEqual({
			ok: true,
			data: "done",
		});
		expect(host.setSyncBridge).toHaveBeenCalledWith(bridge);
		expect(host.setSyncBridge.mock.invocationCallOrder[0]).toBeLessThan(
			host.handleHostMessage.mock.invocationCallOrder[0]!,
		);
	});
	it("propagates a chunk-load failure instead of running without a bridge", async () => {
		host.fail = true;
		const client = await import("./offscreen-client");
		client.setInProcessSyncBridge(bridge);
		await expect(client.sendToOffscreen({ type: "SYNC_ROSTER_SYNC" })).rejects.toThrow();
		expect(host.handleHostMessage).not.toHaveBeenCalled();
	});
	it("fails explicitly when the bridge has not been registered", async () => {
		const client = await import("./offscreen-client");
		await expect(client.sendToOffscreen({ type: "SYNC_ROSTER_SYNC" })).rejects.toThrow(
			"sync bridge not registered",
		);
		expect(host.handleHostMessage).not.toHaveBeenCalled();
	});
	it("uses messaging on Chromium without importing the in-process host", async () => {
		const sendMessage = vi.fn(async () => ({ ok: true }));
		vi.stubGlobal("chrome", {
			runtime: { sendMessage },
			offscreen: { hasDocument: async () => true },
		});
		const client = await import("./offscreen-client");
		client.setInProcessSyncBridge(bridge);
		await expect(client.sendToOffscreen({ type: "SYNC_ROSTER_SYNC" })).resolves.toEqual({
			ok: true,
		});
		expect(sendMessage).toHaveBeenCalledWith({ type: "SYNC_ROSTER_SYNC", target: "offscreen" });
		expect(host.loads).toBe(0);
	});
});
