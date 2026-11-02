import { describe, expect, it, vi } from "vitest";

const native = {
	createPeer: vi.fn(async () => ({ value: 1 })),
	createDataChannel: vi.fn(async () => {}),
	send: vi.fn(async () => {}),
	close: vi.fn(async () => {}),
	addListener: vi.fn(async () => ({ remove: async () => {} })),
};
vi.mock("@capacitor/core", () => ({
	Capacitor: { getPlatform: () => "ios" },
	registerPlugin: () => native,
}));

const { installNativeWebRtc } = await import("./native-webrtc");
installNativeWebRtc();
type Channel = { send(d: string): void; onclose: (() => void) | null; readyState: string };
const PeerConnection = (globalThis as { RTCPeerConnection?: unknown })
	.RTCPeerConnection as new (c: {
	iceServers: unknown[];
}) => { createDataChannel(label: string): Channel };

describe("native WebRTC shim: send", () => {
	it("closes the channel when the native side gives up on a send", async () => {
		native.send.mockRejectedValueOnce(new Error("send: timed out"));
		const channel = new PeerConnection({ iceServers: [] }).createDataChannel("sync");
		const closed = vi.fn();
		channel.onclose = closed;
		channel.send("envelope");
		await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
		expect(channel.readyState).toBe("closed");
	});

	it("leaves the channel alone when a send goes through", async () => {
		const channel = new PeerConnection({ iceServers: [] }).createDataChannel("sync");
		const closed = vi.fn();
		channel.onclose = closed;
		channel.send("envelope");
		await vi.waitFor(() =>
			expect(native.send).toHaveBeenLastCalledWith({ peer: 1, data: "envelope" }),
		);
		await new Promise((r) => setTimeout(r, 10));
		expect(closed).not.toHaveBeenCalled();
	});
});
