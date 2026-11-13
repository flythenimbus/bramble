import { afterEach, describe, expect, it, vi } from "vitest";

// The shim itself is tested in @core (native-rtc.test.ts); this is the Tauri side of it.
const h = vi.hoisted(() => ({
	order: [] as string[],
	invoke: vi.fn(async (cmd: string, _args?: Record<string, unknown>): Promise<unknown> => {
		h.order.push(cmd);
		return cmd === "webrtc_create_peer" ? 7 : undefined;
	}),
	listener: null as ((e: { payload: unknown }) => void) | null,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
	listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
		h.order.push(`listen ${name}`);
		h.listener = cb;
		return () => {};
	},
}));

const g = globalThis as { RTCPeerConnection?: unknown };

afterEach(() => {
	h.order.length = 0;
	h.invoke.mockClear();
	delete g.RTCPeerConnection;
});

async function load() {
	vi.resetModules();
	return import("./native-webrtc");
}

type Channel = { send(d: string): void; onmessage: ((e: { data: string }) => void) | null };

describe("native WebRTC in the desktop webview", () => {
	it("leaves a webview that has its own RTCPeerConnection alone", async () => {
		class Browser {}
		g.RTCPeerConnection = Browser;
		await (await load()).installNativeWebRtc();
		expect(g.RTCPeerConnection).toBe(Browser);
		expect(h.order).toEqual([]);
	});

	it("listens, clears what an earlier window left, then installs", async () => {
		await (await load()).installNativeWebRtc();
		expect(h.order).toEqual(["listen native-webrtc", "webrtc_close_all"]);
		expect(typeof g.RTCPeerConnection).toBe("function");
	});

	it("speaks the commands' argument names and hears the window event", async () => {
		await (await load()).installNativeWebRtc();
		const PC = g.RTCPeerConnection as new (c: {
			iceServers: unknown[];
		}) => { createDataChannel(label: string): Channel };
		const channel = new PC({ iceServers: [{ urls: "stun:x" }] }).createDataChannel("sync");
		channel.send("envelope");
		await vi.waitFor(() =>
			expect(h.invoke).toHaveBeenLastCalledWith("webrtc_send", { peer: 7, data: "envelope" }),
		);
		expect(h.invoke).toHaveBeenCalledWith("webrtc_create_peer", {
			iceServersJson: JSON.stringify([{ urls: "stun:x" }]),
		});
		expect(h.invoke).toHaveBeenCalledWith("webrtc_create_data_channel", { peer: 7, label: "sync" });

		const got: string[] = [];
		channel.onmessage = (e) => got.push(e.data);
		h.listener?.({ payload: { kind: "message", peer: 7, data: "hello" } });
		expect(got).toEqual(["hello"]);
	});
});
