import { describe, expect, it } from "vitest";
import type { Channel } from "./channel";
import type { MeshOptions, PeerSession } from "./mesh";
import type { NostrWasm } from "./nostr-signer";
import { type Stoppable, startMeshSession } from "./peer-session";

// makeNostr only touches these three; the values are placeholder base64.
const fakeWasm: NostrWasm = {
	nostr_generate_key: () => ({ secretKey: "AA==", publicKey: "AA==" }),
	nostr_sign: () => "AA==",
	nostr_verify: () => true,
};

const fakePeer: PeerSession = {
	remotePubkey: "peer",
	initiator: true,
	channel: {} as Channel,
	close: () => {},
};

/** A fake mesh joiner: captures the MeshOptions and counts stop() calls. */
function fakeJoin() {
	let captured: MeshOptions | undefined;
	let stops = 0;
	const join = (opts: MeshOptions): Promise<Stoppable> => {
		captured = opts;
		return Promise.resolve({ stop: () => void stops++ });
	};
	return { join, opts: () => captured, stops: () => stops };
}

const base = {
	relayUrl: "wss://r",
	groupKeyB64: "AAAA",
	roomLabel: "test/room",
	wasm: fakeWasm,
	report: () => {},
	onPeer: async () => {},
	fetchIce: async () => [], // stay offline in tests
};

describe("startMeshSession", () => {
	it("joins with the decoded group key, the room label, and a signer", async () => {
		const j = fakeJoin();
		await startMeshSession({ ...base, join: j.join });
		const opts = j.opts();
		expect(opts?.relayUrl).toBe("wss://r");
		expect(opts?.roomLabel).toBe("test/room");
		expect(opts?.groupKey).toBeInstanceOf(Uint8Array);
		expect(typeof opts?.signer.pubkeyHex).toBe("string");
	});

	it("forwards each connected peer to onPeer", async () => {
		const j = fakeJoin();
		let got: PeerSession | undefined;
		await startMeshSession({
			...base,
			onPeer: async (p) => {
				got = p;
			},
			join: j.join,
		});
		j.opts()?.onPeer(fakePeer);
		expect(got).toBe(fakePeer);
	});

	it("reports an onPeer rejection instead of letting it escape", async () => {
		const j = fakeJoin();
		const logs: string[] = [];
		await startMeshSession({
			...base,
			report: (s) => void logs.push(s),
			onPeer: async () => {
				throw new Error("boom");
			},
			join: j.join,
		});
		j.opts()?.onPeer(fakePeer);
		await new Promise((r) => setTimeout(r, 0));
		expect(logs.some((l) => l.startsWith("peer error:"))).toBe(true);
	});

	it("stops the mesh and runs onStop once, idempotently", async () => {
		const j = fakeJoin();
		let onStops = 0;
		const session = await startMeshSession({ ...base, onStop: () => void onStops++, join: j.join });
		session.stop();
		session.stop();
		expect(j.stops()).toBe(1);
		expect(onStops).toBe(1);
	});
});
