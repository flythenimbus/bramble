import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64 } from "../../util/bytes";
import { buildSignalEvent, encryptSignal } from "../nostr";
import { type MeshSession, startMeshSession } from "./peer-session";
import { createPeer, type PeerSignal } from "./webrtc-peer";

vi.mock("./webrtc-peer", () => ({ createPeer: vi.fn() }));

const GROUP_KEY = new Uint8Array(32).fill(7);
const REMOTE = "ff".repeat(32);
const sockets: FakeSocket[] = [];
const sessions: MeshSession[] = [];

class FakeSocket {
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((ev: { data: string }) => void) | null = null;
	sent: string[] = [];

	constructor(public url: string) {
		sockets.push(this);
	}
	send(data: string): void {
		this.sent.push(data);
	}
	close(): void {}
	open(): void {
		this.onopen?.();
	}
	subId(): string {
		const req = this.sent.map((frame) => JSON.parse(frame)).find((msg) => msg[0] === "REQ");
		return req[1];
	}
}

const server = (username: string): RTCIceServer => ({
	urls: ["turn:turn.example.com:3478"],
	username,
	credential: "hmac",
});

async function start(fetchIce?: () => Promise<RTCIceServer[]>): Promise<MeshSession> {
	const session = await startMeshSession({
		relayUrl: "wss://relay.example.com",
		groupKeyB64: bytesToBase64(GROUP_KEY),
		roomLabel: "bramble/sync",
		wasm: {
			nostr_generate_key: () => ({ secretKey: "AA==", publicKey: "AA==" }),
			nostr_sign: () => "AA==",
			nostr_verify: () => true,
		},
		report: () => {},
		onPeer: async () => {},
		fetchIce,
	});
	sessions.push(session);
	sockets[0]?.open();
	return session;
}

async function deliver(payload: object): Promise<void> {
	const content = await encryptSignal(GROUP_KEY, JSON.stringify(payload));
	const event = await buildSignalEvent(
		{ pubkeyHex: REMOTE, sign: async () => "ee".repeat(32) },
		"room",
		content,
		Math.floor(Date.now() / 1000),
	);
	const socket = sockets[0]!;
	socket.onmessage?.({ data: JSON.stringify(["EVENT", socket.subId(), event]) });
}

beforeEach(() => {
	sockets.length = 0;
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-08T10:00:00Z"));
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.stubGlobal(
		"RTCPeerConnection",
		class {
			close(): void {}
		},
	);
	vi.mocked(createPeer).mockReset();
	vi.mocked(createPeer).mockImplementation(() => ({
		handleSignal: vi.fn(async () => {}),
		send: () => {},
		close: () => {},
	}));
});

afterEach(() => {
	for (const session of sessions.splice(0)) session.stop();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("ICE credentials for new peer connections", () => {
	it("mints fresh credentials for a late pairing attempt and again on reconnect", async () => {
		const mint = vi.fn(async () => ({
			ok: true,
			json: async () => ({
				iceServers: [server(`${Math.floor(Date.now() / 1000) + 60}:bramble`)],
				ttl: 60,
			}),
		}));
		vi.stubGlobal("fetch", mint);
		await start();

		// The inviter can wait for a scan longer than the TURN credential's lifetime.
		vi.setSystemTime(new Date("2026-10-08T10:01:01Z"));
		await deliver({ kind: "hello", rtc: true });
		await vi.waitFor(() => expect(createPeer).toHaveBeenCalledTimes(1));
		const first = vi.mocked(createPeer).mock.calls[0]![0];
		expect(Number(first.iceServers![0]!.username!.split(":")[0])).toBeGreaterThan(
			Date.now() / 1000,
		);

		first.onClose();
		vi.setSystemTime(new Date("2026-10-08T10:02:02Z"));
		await deliver({ kind: "hello", rtc: true });
		await vi.waitFor(() => expect(createPeer).toHaveBeenCalledTimes(2));
		const second = vi.mocked(createPeer).mock.calls[1]![0];
		expect(Number(second.iceServers![0]!.username!.split(":")[0])).toBeGreaterThan(
			Date.now() / 1000,
		);
		expect(second.iceServers![0]!.username).not.toBe(first.iceServers![0]!.username);
		expect(mint).toHaveBeenLastCalledWith("https://relay.example.com/ice-servers", {
			method: "POST",
		});
	});

	it("falls back to host candidates on mint failure and fetches again for the next connection", async () => {
		const mint = vi
			.fn()
			.mockResolvedValueOnce({ ok: false })
			.mockResolvedValueOnce({ ok: true, json: async () => ({ iceServers: [server("fresh")] }) });
		vi.stubGlobal("fetch", mint);
		await start();
		await deliver({ kind: "hello", rtc: true });
		await vi.waitFor(() => expect(createPeer).toHaveBeenCalledTimes(1));
		const first = vi.mocked(createPeer).mock.calls[0]![0];
		expect(first.iceServers).toEqual([]);

		first.onClose();
		await deliver({ kind: "hello", rtc: true });
		await vi.waitFor(() => expect(createPeer).toHaveBeenCalledTimes(2));
		expect(vi.mocked(createPeer).mock.calls[1]![0].iceServers).toEqual([server("fresh")]);
	});

	it("keeps offers and candidates while the responder fetches credentials", async () => {
		let resolveIce!: (servers: RTCIceServer[]) => void;
		const fetchIce = vi.fn(
			() =>
				new Promise<RTCIceServer[]>((resolve) => {
					resolveIce = resolve;
				}),
		);
		await start(fetchIce);
		const offer: PeerSignal = { kind: "offer", sdp: "remote offer" };
		const candidate: PeerSignal = { kind: "candidate", candidate: { candidate: "remote ICE" } };
		await deliver(offer);
		await vi.waitFor(() => expect(fetchIce).toHaveBeenCalledTimes(1));
		await deliver(candidate);
		await deliver(offer);
		expect(createPeer).not.toHaveBeenCalled();

		resolveIce([server("fresh")]);
		await vi.waitFor(() => expect(createPeer).toHaveBeenCalledTimes(1));
		const peer = vi.mocked(createPeer).mock.results[0]!.value;
		await vi.waitFor(() => expect(peer.handleSignal).toHaveBeenCalledTimes(3));
		expect(peer.handleSignal).toHaveBeenCalledWith(offer);
		expect(peer.handleSignal).toHaveBeenCalledWith(candidate);
		expect(createPeer).toHaveBeenCalledWith(
			expect.objectContaining({
				initiator: false,
				iceServers: [server("fresh")],
			}),
		);
		expect(fetchIce).toHaveBeenCalledTimes(1);
	});

	it("does not create a peer when stopped during an ICE request", async () => {
		let resolveIce!: (servers: RTCIceServer[]) => void;
		const fetchIce = vi.fn(
			() =>
				new Promise<RTCIceServer[]>((resolve) => {
					resolveIce = resolve;
				}),
		);
		const session = await start(fetchIce);
		await deliver({ kind: "hello", rtc: true });
		await vi.waitFor(() => expect(fetchIce).toHaveBeenCalledTimes(1));
		session.stop();
		resolveIce([server("fresh")]);
		// Drain the fetch continuation and peer creation before asserting no side effect.
		for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
		expect(createPeer).not.toHaveBeenCalled();
	});
});
