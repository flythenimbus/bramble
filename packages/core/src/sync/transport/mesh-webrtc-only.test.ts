import { describe, expect, it, vi } from "vitest";

// File bytes travel over WebRTC, direct or relayed by TURN, and never through the signalling relay.
// Pinned here: a WebRTC-only mesh never opens a relay-forward channel, whatever a peer says, and a
// WebRTC-only session hands its connections the TURN servers like any other.

const signaling = vi.hoisted(() => ({
	onEvent: null as ((ev: unknown) => void) | null,
	published: [] as unknown[],
}));

vi.mock("..", async (importOriginal) => ({
	...(await importOriginal<typeof import("..")>()),
	deriveRoomId: async () => "room",
	encryptSignal: async (_key: unknown, json: string) => json,
	decryptSignal: async (_key: unknown, content: string) => content,
	buildSignalEvent: async (_s: unknown, _room: string, content: string) => ({ content }),
	verifyEvent: async () => true,
	clockAheadMinutes: () => null,
	connectSignaling: (_socket: unknown, _rooms: string[], onEvent: (ev: unknown) => void) => {
		signaling.onEvent = onEvent;
		return {
			publish: (ev: unknown) => signaling.published.push(ev),
			close: () => {},
			resubscribe: () => {},
		};
	},
}));

vi.mock("./nostr-signer", () => ({ makeNostr: async () => ({}) }));

class FakeSocket {
	onerror: (() => void) | null = null;
	onclose: (() => void) | null = null;
	close() {}
}

const { joinMesh } = await import("./mesh");
const { startMeshSession } = await import("./peer-session");

const event = (pubkey: string, payload: unknown) => ({
	pubkey,
	created_at: Math.floor(Date.now() / 1000),
	content: JSON.stringify(payload),
});

async function meshWith(webrtcOnly: boolean) {
	vi.stubGlobal("WebSocket", FakeSocket);
	const peers: unknown[] = [];
	const statuses: string[] = [];
	const states: [string, string][] = [];
	const mesh = await joinMesh({
		relayUrl: "wss://relay.invalid",
		groupKey: new Uint8Array(32),
		roomLabel: "bramble/blob",
		signer: { pubkeyHex: "aaaa", signer: {}, verifier: {} } as never,
		onStatus: (s) => statuses.push(s),
		onPeer: (p) => peers.push(p),
		onPeerState: (remote, state) => states.push([remote, state]),
		webrtcOnly,
	});
	return { mesh, peers, statuses, states };
}

describe("a WebRTC-only mesh", () => {
	// No RTCPeerConnection in this runtime, which is exactly the Firefox case: an ordinary mesh
	// falls back to relay-forward, and a WebRTC-only one must not.
	it("never opens a relay-forward channel to a peer without WebRTC", async () => {
		const { mesh, peers, statuses } = await meshWith(true);
		signaling.onEvent?.(event("bbbb", { kind: "hello", rtc: false }));
		signaling.onEvent?.(
			event("bbbb", { kind: "data", to: "aaaa", msgId: 0, idx: 0, total: 1, chunk: "x" }),
		);
		await new Promise((r) => setTimeout(r, 20));
		expect(peers).toHaveLength(0);
		expect(statuses.some((s) => s.includes("needs a WebRTC connection"))).toBe(true);
		mesh.stop();
	});

	it("reports the device it found, so a session can say it can't be reached", async () => {
		const { mesh, states } = await meshWith(true);
		signaling.onEvent?.(event("bbbb", { kind: "hello", rtc: false }));
		await new Promise((r) => setTimeout(r, 20));
		expect(states).toEqual([["bbbb", "found"]]);
		mesh.stop();
	});

	it("is the only difference: an ordinary mesh does relay-forward the same peer", async () => {
		const { mesh, peers } = await meshWith(false);
		signaling.onEvent?.(event("bbbb", { kind: "hello", rtc: false }));
		await new Promise((r) => setTimeout(r, 20));
		expect(peers).toHaveLength(1);
		mesh.stop();
	});
});

describe("a WebRTC-only session's ICE list", () => {
	it("keeps the TURN servers, so a pair with no direct path can still move a file", async () => {
		let joinedWith: {
			getIceServers?: (ticket: string | null) => Promise<RTCIceServer[]>;
			webrtcOnly?: boolean;
		} | null = null;
		const minted = [
			{
				urls: ["stun:stun.example:3478", "turn:turn.example:3478", "turns:turn.example:5349"],
				username: "u",
				credential: "c",
			},
		];
		await startMeshSession({
			relayUrl: "wss://relay.invalid",
			groupKeyB64: "AAAA",
			roomLabel: "bramble/blob",
			wasm: {} as never,
			report: () => {},
			webrtcOnly: true,
			onPeer: async () => {},
			fetchIce: async () => minted,
			join: async (opts) => {
				joinedWith = opts;
				return { stop: () => {} };
			},
		});
		expect(joinedWith).toMatchObject({ webrtcOnly: true });
		expect(await joinedWith!.getIceServers!(null)).toEqual(minted);
	});
});
