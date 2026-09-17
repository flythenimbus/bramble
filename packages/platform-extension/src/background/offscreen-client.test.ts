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
	// The memo must not cache a rejection: one failure would otherwise reject every later
	// CRYPTO_*/SYNC_* op for the life of the event page, not just the caller that hit it.
	it("retries the host load after a transient chunk-load failure", async () => {
		host.fail = true;
		const client = await import("./offscreen-client");
		client.setInProcessSyncBridge(bridge);
		await expect(client.sendToOffscreen({ type: "SYNC_ROSTER_SYNC" })).rejects.toThrow();
		host.fail = false;
		await expect(client.sendToOffscreen({ type: "SYNC_ROSTER_SYNC" })).resolves.toEqual({
			ok: true,
			data: "done",
		});
	});
	it("recovers once the bridge is registered after a failed op", async () => {
		const client = await import("./offscreen-client");
		await expect(client.sendToOffscreen({ type: "SYNC_ROSTER_SYNC" })).rejects.toThrow(
			"sync bridge not registered",
		);
		client.setInProcessSyncBridge(bridge);
		await expect(client.sendToOffscreen({ type: "SYNC_ROSTER_SYNC" })).resolves.toEqual({
			ok: true,
			data: "done",
		});
	});
	// The other half of the memo: retrying on failure must not turn into re-importing per message.
	it("loads the host once across repeated ops on the happy path", async () => {
		const client = await import("./offscreen-client");
		client.setInProcessSyncBridge(bridge);
		await client.sendToOffscreen({ type: "SYNC_ROSTER_SYNC" });
		await client.sendToOffscreen({ type: "SYNC_ROSTER_SYNC" });
		await client.sendToOffscreen({ type: "SYNC_ROSTER_SYNC" });
		expect(host.loads).toBe(1);
		expect(host.setSyncBridge).toHaveBeenCalledTimes(1);
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
