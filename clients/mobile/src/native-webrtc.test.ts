import { describe, expect, it, vi } from "vitest";

// The shim itself is tested in @core (native-rtc.test.ts); this is the Capacitor plugin's side.
const listeners = new Map<string, (data: Record<string, unknown>) => void>();
const native = {
	createPeer: vi.fn(async () => ({ value: 1 })),
	createDataChannel: vi.fn(async () => {}),
	send: vi.fn(async () => {}),
	close: vi.fn(async () => {}),
	addListener: vi.fn(async (name: string, cb: (data: Record<string, unknown>) => void) => {
		listeners.set(name, cb);
		return { remove: async () => {} };
	}),
};
let platform = "android";
vi.mock("@capacitor/core", () => ({
	Capacitor: { getPlatform: () => platform },
	registerPlugin: () => native,
}));

const { installNativeWebRtc } = await import("./native-webrtc");
const g = globalThis as { RTCPeerConnection?: unknown };

type Channel = { send(d: string): void; onmessage: ((e: { data: string }) => void) | null };

describe("native WebRTC on iOS", () => {
	it("leaves RTCPeerConnection alone off iOS", () => {
		installNativeWebRtc();
		expect(g.RTCPeerConnection).toBeUndefined();
		expect(native.addListener).not.toHaveBeenCalled();
	});

	it("speaks the plugin's call shapes and hears its events", async () => {
		platform = "ios";
		installNativeWebRtc();
		const PC = g.RTCPeerConnection as new (c: {
			iceServers: unknown[];
		}) => { createDataChannel(label: string): Channel };
		const channel = new PC({ iceServers: [] }).createDataChannel("sync");
		channel.send("envelope");
		await vi.waitFor(() =>
			expect(native.send).toHaveBeenLastCalledWith({ peer: 1, data: "envelope" }),
		);
		expect(native.createDataChannel).toHaveBeenCalledWith({ peer: 1, label: "sync" });

		const got: string[] = [];
		channel.onmessage = (e) => got.push(e.data);
		listeners.get("message")?.({ peer: 1, data: "hello" });
		expect(got).toEqual(["hello"]);
	});
});
