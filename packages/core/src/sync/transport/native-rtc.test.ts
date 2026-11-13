import { beforeEach, describe, expect, it, vi } from "vitest";
import { installNativeRtc, type NativeRtcBridge, type NativeRtcEvent } from "./native-rtc";

// A bridge that records every native call, in order, and lets a test raise native events.
const calls: string[] = [];
let emit: (e: NativeRtcEvent) => void = () => {};
let nextPeer = 1;
const bridge: NativeRtcBridge = {
	createPeer: vi.fn(async () => {
		calls.push("createPeer");
		return nextPeer++;
	}),
	createDataChannel: vi.fn(async (peer: number, label: string) => {
		calls.push(`createDataChannel ${peer} ${label}`);
	}),
	createOffer: vi.fn(async (peer: number) => {
		calls.push(`createOffer ${peer}`);
		return "offer-sdp";
	}),
	createAnswer: vi.fn(async () => "answer-sdp"),
	setLocalDescription: vi.fn(async () => {}),
	setRemoteDescription: vi.fn(async () => {}),
	addIceCandidate: vi.fn(async () => {}),
	send: vi.fn(async () => {}),
	close: vi.fn(async () => {}),
	onEvent: (cb) => {
		emit = cb;
	},
};

installNativeRtc(bridge);

type Channel = {
	send(d: string): void;
	onopen: (() => void) | null;
	onmessage: ((e: { data: string }) => void) | null;
	onclose: (() => void) | null;
	readyState: string;
};
type PeerConnection = {
	createDataChannel(label: string): Channel;
	createOffer(): Promise<{ type: string; sdp: string }>;
	onicecandidate: ((e: { candidate: { toJSON(): unknown } | null }) => void) | null;
	ondatachannel: ((e: { channel: Channel }) => void) | null;
	connectionState: string;
};
const PC = (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection as new (c: {
	iceServers: unknown[];
}) => PeerConnection;

/** A connection whose native peer exists, with its handle. */
async function connected(): Promise<{ pc: PeerConnection; peer: number }> {
	const peer = nextPeer;
	const pc = new PC({ iceServers: [] });
	await vi.waitFor(() => expect(bridge.createPeer).toHaveBeenCalled());
	await new Promise((r) => setTimeout(r, 0));
	return { pc, peer };
}

beforeEach(() => {
	calls.length = 0;
});

describe("native RTCPeerConnection shim: send", () => {
	it("closes the channel when the native side gives up on a send", async () => {
		vi.mocked(bridge.send).mockRejectedValueOnce(new Error("send: timed out"));
		const channel = new PC({ iceServers: [] }).createDataChannel("sync");
		const closed = vi.fn();
		channel.onclose = closed;
		channel.send("envelope");
		await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
		expect(channel.readyState).toBe("closed");
	});

	it("leaves the channel alone when a send goes through", async () => {
		const { pc, peer } = await connected();
		const channel = pc.createDataChannel("sync");
		const closed = vi.fn();
		channel.onclose = closed;
		channel.send("envelope");
		await vi.waitFor(() => expect(bridge.send).toHaveBeenLastCalledWith(peer, "envelope"));
		await new Promise((r) => setTimeout(r, 10));
		expect(closed).not.toHaveBeenCalled();
	});
});

describe("native RTCPeerConnection shim: ordering", () => {
	it("reaches the native side in call order, once the peer exists", async () => {
		const pc = new PC({ iceServers: [] });
		pc.createDataChannel("sync");
		const offer = await pc.createOffer();
		expect(offer).toEqual({ type: "offer", sdp: "offer-sdp" });
		const peer = nextPeer - 1;
		expect(calls).toEqual(["createPeer", `createDataChannel ${peer} sync`, `createOffer ${peer}`]);
	});
});

describe("native RTCPeerConnection shim: events", () => {
	it("routes each native event to the connection it belongs to", async () => {
		const { pc, peer } = await connected();
		const other = await connected();
		const candidates: unknown[] = [];
		pc.onicecandidate = (e) => candidates.push(e.candidate?.toJSON() ?? null);
		other.pc.onicecandidate = () => {
			throw new Error("the other connection must not hear this");
		};
		const json = {
			candidate: "candidate:1 1 udp 2 1.2.3.4 5 typ host",
			sdpMid: "0",
			sdpMLineIndex: 0,
		};
		emit({ kind: "iceCandidate", peer, candidateJson: JSON.stringify(json) });
		emit({ kind: "iceGatheringComplete", peer });
		expect(candidates).toEqual([json, null]);

		let channel: Channel | null = null;
		pc.ondatachannel = (e) => {
			channel = e.channel;
		};
		emit({ kind: "dataChannel", peer });
		const got: string[] = [];
		const opened = vi.fn();
		if (!channel) throw new Error("no channel");
		const ch = channel as Channel;
		ch.onopen = opened;
		ch.onmessage = (e) => got.push(e.data);
		emit({ kind: "dataChannelOpen", peer });
		emit({ kind: "message", peer, data: "hello" });
		expect(opened).toHaveBeenCalledOnce();
		expect(ch.readyState).toBe("open");
		expect(got).toEqual(["hello"]);
	});

	it("closes the channel when the connection fails", async () => {
		const { pc, peer } = await connected();
		const channel = pc.createDataChannel("sync");
		const closed = vi.fn();
		channel.onclose = closed;
		emit({ kind: "connectionState", peer, state: "failed" });
		expect(pc.connectionState).toBe("failed");
		expect(closed).toHaveBeenCalledOnce();
	});
});
