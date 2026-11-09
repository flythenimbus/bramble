import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPeer } from "./webrtc-peer";

// The mesh will not connect to a peer it still holds, so a connection that ends without saying so
// shuts that device out until a session restarts (issue #205). Measured on WKWebView and Chromium:
// close() fires no connection state change, and nothing at all fires for an offer nobody answers.
// The fake's close() fires nothing either, so these can't lean on an event.

class FakeChannel {
	readyState = "connecting";
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: unknown }) => void) | null = null;
	onclose: (() => void) | null = null;
	close = vi.fn();
	send = vi.fn();
}

class FakeConnection {
	static last: FakeConnection;
	connectionState = "new";
	iceConnectionState = "new";
	closed = false;
	channel = new FakeChannel();
	onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
	onconnectionstatechange: (() => void) | null = null;
	oniceconnectionstatechange: (() => void) | null = null;
	ondatachannel: ((e: { channel: FakeChannel }) => void) | null = null;

	constructor() {
		FakeConnection.last = this;
	}
	createDataChannel() {
		return this.channel;
	}
	async createOffer() {
		return { type: "offer", sdp: "our offer" };
	}
	async createAnswer() {
		return { type: "answer", sdp: "our answer" };
	}
	async setLocalDescription() {}
	async setRemoteDescription() {
		if (this.closed) throw new Error("The object is in an invalid state.");
	}
	async addIceCandidate() {}
	close = vi.fn(() => {
		this.closed = true;
	});
}

function start(initiator: boolean) {
	const onClose = vi.fn();
	const onOpen = vi.fn();
	const states: string[] = [];
	const peer = createPeer({
		initiator,
		onSignal: () => {},
		onOpen,
		onMessage: () => {},
		onClose,
		onState: (s) => states.push(s),
	});
	const pc = FakeConnection.last;
	return { peer, pc, onClose, onOpen, states };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("RTCPeerConnection", FakeConnection);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("how a connection ends", () => {
	it("reports a local close without waiting for an engine event", () => {
		const { peer, pc, onClose } = start(true);

		peer.close();

		expect(pc.close).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("reports the end once, however many parts of the connection notice it", () => {
		const { peer, pc, onClose } = start(true);

		pc.iceConnectionState = "failed";
		pc.oniceconnectionstatechange?.();
		pc.connectionState = "failed";
		pc.onconnectionstatechange?.();
		pc.channel.onclose?.();
		peer.close();

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("closes a connection whose ICE failed, since nothing else holds one that never opened", () => {
		const { pc } = start(true);

		pc.iceConnectionState = "failed";
		pc.oniceconnectionstatechange?.();

		expect(pc.close).toHaveBeenCalledTimes(1);
	});

	it("closes the connection when its channel closes", () => {
		const { pc, onClose } = start(true);

		pc.channel.onclose?.();

		expect(pc.close).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});

describe("a connection that never gets going", () => {
	it("gives up on an offer nobody answers, which no event would ever report", async () => {
		const { pc, onClose, states } = start(true);

		await vi.advanceTimersByTimeAsync(59_000);
		expect(onClose).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(2_000);
		expect(pc.close).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(states.at(-1)).toMatch(/giving up/);
	});

	it("leaves a connection alone once its channel has opened", async () => {
		const { pc, onClose, onOpen } = start(true);

		pc.channel.onopen?.();
		await vi.advanceTimersByTimeAsync(10 * 60_000);

		expect(onOpen).toHaveBeenCalledTimes(1);
		expect(onClose).not.toHaveBeenCalled();
	});

	it("does not report the end twice when the deadline passes after a close", async () => {
		const { peer, onClose } = start(true);

		peer.close();
		await vi.advanceTimersByTimeAsync(10 * 60_000);

		expect(onClose).toHaveBeenCalledTimes(1);
	});
});

describe("an offer that could not be made", () => {
	it("ends the connection rather than leaving it to the deadline", async () => {
		const createOffer = vi
			.spyOn(FakeConnection.prototype, "createOffer")
			.mockRejectedValueOnce(new Error("no"));
		const { pc, onClose, states } = start(true);

		await vi.advanceTimersByTimeAsync(0);

		expect(states.at(-1)).toBe("offer error: no");
		expect(pc.close).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalledTimes(1);
		createOffer.mockRestore();
	});
});

describe("a signal that cannot be applied", () => {
	it("ends the connection, so the mesh can start over instead of holding a dead one", async () => {
		const { peer, pc, onClose, states } = start(false);
		pc.closed = true;

		await peer.handleSignal({ kind: "offer", sdp: "their offer" });

		expect(states.at(-1)).toBe("signal error (offer): The object is in an invalid state.");
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("keeps a working connection when a stray answer fails", async () => {
		const { peer, pc, onClose, states } = start(true);
		await vi.advanceTimersByTimeAsync(0); // the offer is out
		pc.channel.onopen?.();
		vi.spyOn(pc, "setRemoteDescription").mockRejectedValueOnce(new Error("wrong state: stable"));

		await peer.handleSignal({ kind: "answer", sdp: "a stray answer" });

		expect(states.at(-1)).toBe("signal error (answer): wrong state: stable");
		expect(pc.close).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});

	it("keeps a connection whose offer applied", async () => {
		const { peer, onClose, states } = start(false);

		await peer.handleSignal({ kind: "offer", sdp: "their offer" });

		expect(states.at(-1)).toBe("answer sent");
		expect(onClose).not.toHaveBeenCalled();
	});
});
